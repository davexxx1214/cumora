//go:build linux

package projectfs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/hanwen/go-fuse/v2/fuse"
)

func TestClientInterrupt(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"entry":{"id":"file"}}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "project", "test-lease")
	interrupted := make(chan struct{})
	close(interrupted)
	result, code := client.operation(&fuse.Context{Cancel: interrupted}, map[string]any{"type": "mkdir"})
	if code != 0 || result.Entry == nil || result.Entry.ID != "file" {
		t.Fatalf("FUSE interruption must finish the bounded operation: %v %+v", code, result)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if client.Heartbeat(ctx) == 0 {
		t.Fatal("supervisor cancellation must still stop heartbeats")
	}
	if requests.Load() != 1 {
		t.Fatalf("unexpected API calls: %d", requests.Load())
	}
}

// This test is launched by the isolated Node integration harness. Tokens arrive
// through stdin, never through process arguments or a production credential.
func TestKernelProjectFiles(t *testing.T) {
	if os.Getenv("CUMORA_PROJECT_FS_MOUNT_TEST") != "1" {
		t.Skip("requires isolated Linux integration harness")
	}
	uidMap, err := os.ReadFile("/proc/self/uid_map")
	if err != nil || os.Geteuid() != 0 || bytes.Contains(uidMap, []byte("4294967295")) {
		t.Fatal("a disposable unprivileged user/mount/PID namespace is required")
	}
	var config struct {
		Server, Project string
		Tokens          []string
	}
	if err := json.NewDecoder(os.Stdin).Decode(&config); err != nil || len(config.Tokens) != 2 {
		t.Fatal("invalid test configuration")
	}
	left, right := t.TempDir(), t.TempDir()
	for i, mount := range []string{left, right} {
		server, err := Mount(mount, NewClient(config.Server, config.Project, config.Tokens[i]))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := server.Unmount(); err != nil {
				t.Error(err)
			}
		})
	}
	t.Run("shell_binary_directories_and_trash", func(t *testing.T) {
		script := `set -eu
cd "$1"
mkdir -p '文档 空间/nested'
printf 'hello\000binary\377' > '文档 空间/nested/data.bin'
cp '文档 空间/nested/data.bin' copied.bin
cmp copied.bin '文档 空间/nested/data.bin'
mv copied.bin renamed.bin
cat renamed.bin > /dev/null
rm renamed.bin
mkdir empty
rmdir empty
ls '文档 空间/nested' >/dev/null`
		cmd := exec.Command("sh", "-c", script, "project-test", left)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("shell operations: %v: %s", err, out)
		}
		got, err := os.ReadFile(filepath.Join(right, "文档 空间/nested/data.bin"))
		if err != nil || !bytes.Equal(got, []byte("hello\x00binary\xff")) {
			t.Fatalf("shared binary read: %v", err)
		}
	})
	t.Run("python_temporary_rename", func(t *testing.T) {
		script := `import os, pathlib, sys
root = pathlib.Path(sys.argv[1])
target = root / 'document.bin'
target.write_bytes(bytes(range(256)))
old = target.read_bytes()
tmp = root / '.document.tmp'
with tmp.open('wb') as f:
    f.write(old + b'updated')
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, target)
assert target.read_bytes() == bytes(range(256)) + b'updated'
`
		cmd := exec.Command("python3", "-c", script, left)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Python rename save: %v: %s", err, out)
		}
	})
	t.Run("concurrent_handles_and_stale_editor_rename", func(t *testing.T) {
		path := filepath.Join(left, "concurrent.txt")
		if err := os.WriteFile(path, []byte("base"), 0600); err != nil {
			t.Fatal(err)
		}
		a, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer a.Close()
		b, err := os.OpenFile(filepath.Join(right, "concurrent.txt"), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer b.Close()
		if _, err := a.WriteAt([]byte("left"), 0); err != nil {
			t.Fatal(err)
		}
		if _, err := b.WriteAt([]byte("rght"), 0); err != nil {
			t.Fatal(err)
		}
		if err := a.Sync(); err != nil {
			t.Fatal(err)
		}
		if err := b.Sync(); !errors.Is(err, syscall.ESTALE) {
			t.Fatalf("expected ESTALE, got %v", err)
		}
		tmp := filepath.Join(right, ".stale.tmp")
		if err := os.WriteFile(tmp, []byte("stale editor"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, filepath.Join(right, "concurrent.txt")); !errors.Is(err, syscall.ESTALE) {
			t.Fatalf("rename must retain old observed target version: %v", err)
		}
		if _, err := os.Stat(tmp); err != nil {
			t.Fatalf("temporary conflict content was lost: %v", err)
		}
	})
	t.Run("stale_read_then_truncate_cannot_overwrite_new_content", func(t *testing.T) {
		path := filepath.Join(left, "stale-open.txt")
		other := filepath.Join(right, "stale-open.txt")
		if err := os.WriteFile(path, []byte("initial"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := os.ReadFile(other); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("newer"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(other, []byte("stale"), 0600); !errors.Is(err, syscall.ESTALE) {
			t.Fatalf("stale overwrite must fail, got %v", err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != "newer" {
			t.Fatalf("new content lost: %q %v", got, err)
		}
	})
	t.Run("unsupported_links_and_sparse_quota", func(t *testing.T) {
		if err := os.Symlink("document.bin", filepath.Join(left, "link")); !errors.Is(err, syscall.EPERM) {
			t.Fatalf("symlink: %v", err)
		}
		if err := os.Link(filepath.Join(left, "document.bin"), filepath.Join(left, "hardlink")); !errors.Is(err, syscall.EPERM) {
			t.Fatalf("hardlink: %v", err)
		}
		file, err := os.OpenFile(filepath.Join(left, "too-large.bin"), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		if _, err := file.WriteAt([]byte{1}, MaxFileBytes); !errors.Is(err, syscall.EFBIG) {
			t.Fatalf("sparse write bypassed size limit: %v", err)
		}
	})
	t.Run("revocation_on_open_descriptor", func(t *testing.T) {
		file, err := os.OpenFile(filepath.Join(left, "document.bin"), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		buf := make([]byte, 1)
		if _, err := file.ReadAt(buf, 0); err != nil {
			t.Fatal(err)
		}
		response, err := http.Post(config.Server+"/test/revoke-project-lease", "application/json", bytes.NewBufferString("{}"))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("test revocation failed")
		}
		if _, err := file.ReadAt(buf, 0); !errors.Is(err, syscall.EACCES) {
			t.Fatalf("read after revoke: %v", err)
		}
		if _, err := file.WriteAt(buf, 0); !errors.Is(err, syscall.EACCES) {
			t.Fatalf("write after revoke: %v", err)
		}
		if err := file.Sync(); !errors.Is(err, syscall.EACCES) {
			t.Fatalf("sync after revoke: %v", err)
		}
		if _, err := os.ReadDir(left); !errors.Is(err, syscall.EACCES) {
			t.Fatalf("readdir after revoke: %v", err)
		}
	})
}
