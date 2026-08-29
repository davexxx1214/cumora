//go:build linux

package main

// P0 kernel-facing spike, deliberately backed by an in-memory test fixture.
// This is not the production project filesystem or an API authorization test.
// Opt in only inside a disposable user/mount/PID namespace; no sudo fallback.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type projectProbeContent struct {
	mu        sync.Mutex
	version   uint64
	body      []byte
	conflicts [][]byte
}

type projectProbeAccess struct{ revoked atomic.Bool }

type projectProbeRoot struct {
	fs.Inode
	content *projectProbeContent
	access  *projectProbeAccess
}

func (r *projectProbeRoot) OnAdd(ctx context.Context) {
	file := &projectProbeFile{content: r.content, access: r.access}
	r.AddChild("report.bin", r.NewPersistentInode(ctx, file, fs.StableAttr{Mode: syscall.S_IFREG, Ino: 2}), false)
}

func (r *projectProbeRoot) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if r.access.revoked.Load() {
		return nil, syscall.EACCES
	}
	child := r.GetChild(name)
	if child == nil {
		return nil, syscall.ENOENT
	}
	var attr fuse.AttrOut
	code := child.Operations().(*projectProbeFile).Getattr(ctx, nil, &attr)
	out.Attr = attr.Attr
	return child, code
}

func (r *projectProbeRoot) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	if r.access.revoked.Load() {
		return nil, syscall.EACCES
	}
	return fs.NewListDirStream([]fuse.DirEntry{{Name: "report.bin", Mode: syscall.S_IFREG, Ino: 2}}), 0
}

type projectProbeFile struct {
	fs.Inode
	content *projectProbeContent
	access  *projectProbeAccess
}

func (f *projectProbeFile) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	if f.access.revoked.Load() {
		return syscall.EACCES
	}
	f.content.mu.Lock()
	defer f.content.mu.Unlock()
	out.Mode = syscall.S_IFREG | 0600
	out.Size = uint64(len(f.content.body))
	return 0
}

func (f *projectProbeFile) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if f.access.revoked.Load() {
		return nil, 0, syscall.EACCES
	}
	f.content.mu.Lock()
	defer f.content.mu.Unlock()
	h := &projectProbeHandle{content: f.content, access: f.access, version: f.content.version, body: bytes.Clone(f.content.body)}
	return h, fuse.FOPEN_DIRECT_IO, 0
}

type projectProbeHandle struct {
	mu      sync.Mutex
	content *projectProbeContent
	access  *projectProbeAccess
	version uint64
	body    []byte
	dirty   bool
	failed  syscall.Errno
}

func (h *projectProbeHandle) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	if h.access.revoked.Load() {
		return nil, syscall.EACCES
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if off < 0 {
		return nil, syscall.EINVAL
	}
	if off >= int64(len(h.body)) {
		return fuse.ReadResultData(nil), 0
	}
	n := copy(dest, h.body[off:])
	return fuse.ReadResultData(dest[:n]), 0
}

func (h *projectProbeHandle) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	if h.access.revoked.Load() {
		return 0, syscall.EACCES
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if off < 0 || off > 65536 || int64(len(data)) > 65536-off {
		return 0, syscall.EFBIG
	}
	if end := int(off) + len(data); end > len(h.body) {
		h.body = append(h.body, make([]byte, end-len(h.body))...)
	}
	copy(h.body[int(off):], data)
	h.dirty = true
	return uint32(len(data)), 0
}

func (h *projectProbeHandle) Flush(ctx context.Context) syscall.Errno {
	if h.access.revoked.Load() {
		return syscall.EACCES
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.failed != 0 || !h.dirty {
		return h.failed
	}
	h.content.mu.Lock()
	defer h.content.mu.Unlock()
	if h.access.revoked.Load() {
		return syscall.EACCES
	}
	if h.content.version != h.version {
		h.content.conflicts = append(h.content.conflicts, bytes.Clone(h.body))
		h.failed = syscall.ESTALE
		return h.failed
	}
	h.content.body = bytes.Clone(h.body)
	h.content.version++
	h.version = h.content.version
	h.dirty = false
	return 0
}

func (h *projectProbeHandle) Fsync(ctx context.Context, flags uint32) syscall.Errno {
	return h.Flush(ctx)
}

func mountProjectProbe(t *testing.T, content *projectProbeContent) (string, *projectProbeAccess) {
	t.Helper()
	if os.Getenv("CUMORA_PROJECT_FS_MOUNT_TEST") != "1" {
		t.Skip("P0 mount probe requires explicit opt-in in a disposable Linux namespace")
	}
	uidMap, err := os.ReadFile("/proc/self/uid_map")
	if err != nil || os.Geteuid() != 0 || bytes.Contains(uidMap, []byte("4294967295")) {
		t.Fatal("run the probe inside unshare --user --map-root-user --mount --pid; host root is not allowed")
	}
	dir := t.TempDir()
	access := &projectProbeAccess{}
	zero := time.Duration(0)
	server, err := fs.Mount(dir, &projectProbeRoot{content: content, access: access}, &fs.Options{
		MountOptions: fuse.MountOptions{
			DirectMountStrict: true,
			DirectMountFlags:  syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC,
			FsName:            "cumora-project-p0",
			Name:              "cumora-project-p0",
		},
		EntryTimeout: &zero, AttrTimeout: &zero, NegativeTimeout: &zero,
	})
	if err != nil {
		t.Fatalf("real FUSE mount failed (no privilege fallback): %v", err)
	}
	t.Cleanup(func() {
		if err := server.Unmount(); err != nil {
			t.Errorf("unmount probe: %v", err)
		}
	})
	return filepath.Join(dir, "report.bin"), access
}

func TestProjectMountConcurrentHandles(t *testing.T) {
	content := &projectProbeContent{version: 1, body: bytes.Repeat([]byte{0, 255, 17, 128}, 64)}
	firstPath, _ := mountProjectProbe(t, content)
	secondPath, _ := mountProjectProbe(t, content)
	first, err := os.OpenFile(firstPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := os.OpenFile(secondPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	firstBytes := bytes.Repeat([]byte{42}, 256)
	secondBytes := bytes.Repeat([]byte{127}, 256)
	if _, err = first.WriteAt(firstBytes, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = second.WriteAt(secondBytes, 0); err != nil {
		t.Fatal(err)
	}
	if err = first.Sync(); err != nil {
		t.Fatal(err)
	}
	if err = second.Sync(); !errors.Is(err, syscall.ESTALE) {
		t.Fatalf("expected explicit stale-version error, got %v", err)
	}
	got, err := os.ReadFile(firstPath)
	if err != nil || !bytes.Equal(got, firstBytes) {
		t.Fatalf("committed bytes changed: %v", err)
	}
	content.mu.Lock()
	defer content.mu.Unlock()
	if len(content.conflicts) != 1 || !bytes.Equal(content.conflicts[0], secondBytes) {
		t.Fatal("conflicting content was not retained")
	}
}

func TestProjectMountRevokesAnAlreadyOpenHandle(t *testing.T) {
	content := &projectProbeContent{version: 1, body: []byte{0, 255, 17, 128, 42}}
	filePath, access := mountProjectProbe(t, content)
	file, err := os.OpenFile(filePath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	buf := make([]byte, 5)
	if _, err = file.ReadAt(buf, 0); err != nil || !bytes.Equal(buf, content.body) {
		t.Fatalf("binary read: %v", err)
	}
	access.revoked.Store(true)
	if _, err = file.ReadAt(buf, 0); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("cached/open handle read survived revocation: %v", err)
	}
	if _, err = file.WriteAt([]byte{1}, 0); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("open handle write survived revocation: %v", err)
	}
	if err = file.Sync(); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("fsync survived revocation: %v", err)
	}
	if _, err = os.ReadDir(filepath.Dir(filePath)); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("directory listing survived revocation: %v", err)
	}
}
