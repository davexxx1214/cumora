//go:build linux

package projectfs

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type Node struct {
	fs.Inode
	client *Client
	mu     sync.RWMutex
	id     string
	// Linux can send OPEN followed by SETATTR(FATTR_OPEN) without a file
	// handle. Pair that truncate with the opening thread's newest handle.
	opens map[uint32][]*Handle
}

func trace(format string, values ...any) {
	if os.Getenv("CUMORA_PROJECT_FS_TRACE") == "1" {
		fmt.Fprintf(os.Stderr, "projectfs: "+format+"\n", values...)
	}
}
func (n *Node) ID() string      { n.mu.RLock(); defer n.mu.RUnlock(); return n.id }
func (n *Node) setID(id string) { n.mu.Lock(); n.id = id; n.mu.Unlock() }
func callerPID(ctx context.Context) uint32 {
	if c, ok := ctx.(*fuse.Context); ok {
		return c.Caller.Pid
	}
	return 0
}
func (n *Node) track(ctx context.Context, h *Handle) {
	h.pid = callerPID(ctx)
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.opens == nil {
		n.opens = make(map[uint32][]*Handle)
	}
	n.opens[h.pid] = append(n.opens[h.pid], h)
}
func (n *Node) forget(h *Handle) {
	n.mu.Lock()
	defer n.mu.Unlock()
	list := n.opens[h.pid]
	for i, item := range list {
		if item == h {
			n.opens[h.pid] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(n.opens[h.pid]) == 0 {
		delete(n.opens, h.pid)
	}
}
func (n *Node) opening(ctx context.Context) *Handle {
	n.mu.RLock()
	defer n.mu.RUnlock()
	list := n.opens[callerPID(ctx)]
	if len(list) == 0 {
		return nil
	}
	h := list[len(list)-1]
	if !h.writable {
		return nil
	}
	return h
}
func mode(e Entry) uint32 {
	if e.Kind == "directory" {
		return syscall.S_IFDIR | 0700
	}
	return syscall.S_IFREG | 0600
}
func attr(e Entry, out *fuse.Attr) {
	out.Mode = mode(e)
	out.Size = e.Size
	out.Nlink = 1
	if at, err := time.Parse(time.RFC3339Nano, e.ModifiedAt); err == nil {
		out.SetTimes(nil, &at, &at)
	}
}
func (n *Node) Getattr(ctx context.Context, handle fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	e, code := n.client.stat(ctx, n.ID())
	if code != 0 {
		return code
	}
	attr(e, &out.Attr)
	if h, ok := handle.(*Handle); ok {
		h.mu.Lock()
		out.Size = uint64(len(h.body))
		h.mu.Unlock()
	}
	return 0
}
func (n *Node) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	listing, code := n.client.list(ctx, n.ID())
	if code != 0 {
		return nil, code
	}
	for _, item := range listing.Entries {
		if item.Name == name {
			attr(item, &out.Attr)
			if child := n.GetChild(name); child != nil {
				if node, ok := child.Operations().(*Node); ok && node.ID() == item.ID {
					return child, 0
				}
			}
			return n.NewInode(ctx, &Node{client: n.client, id: item.ID}, fs.StableAttr{Mode: mode(item) & syscall.S_IFMT}), 0
		}
	}
	return nil, syscall.ENOENT
}
func (n *Node) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	listing, code := n.client.list(ctx, n.ID())
	if code != 0 {
		return nil, code
	}
	entries := make([]fuse.DirEntry, 0, len(listing.Entries))
	for _, item := range listing.Entries {
		entries = append(entries, fuse.DirEntry{Name: item.Name, Mode: mode(item)})
	}
	return fs.NewListDirStream(entries), 0
}
func (n *Node) Mkdir(ctx context.Context, name string, ignored uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	result, code := n.client.operation(ctx, map[string]any{"type": "mkdir", "parentId": n.ID(), "name": name})
	if code != 0 {
		return nil, code
	}
	if result.Entry == nil {
		return nil, syscall.EIO
	}
	attr(*result.Entry, &out.Attr)
	return n.NewInode(ctx, &Node{client: n.client, id: result.Entry.ID}, fs.StableAttr{Mode: syscall.S_IFDIR}), 0
}
func (n *Node) Create(ctx context.Context, name string, flags, ignored uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	if !n.client.acquireHandle() {
		return nil, nil, 0, syscall.EMFILE
	}
	opened := false
	defer func() {
		if !opened {
			n.client.releaseHandle()
		}
	}()
	result, code := n.client.operation(ctx, map[string]any{"type": "upload", "parentId": n.ID(), "name": name, "content": ""})
	if code != 0 {
		return nil, nil, 0, code
	}
	if result.Entry == nil {
		return nil, nil, 0, syscall.EIO
	}
	node := &Node{client: n.client, id: result.Entry.ID}
	inode := n.NewInode(ctx, node, fs.StableAttr{Mode: syscall.S_IFREG})
	attr(*result.Entry, &out.Attr)
	opened = true
	h := &Handle{node: node, item: *result.Entry, writable: flags&syscall.O_ACCMODE != syscall.O_RDONLY}
	node.track(ctx, h)
	return inode, h, fuse.FOPEN_DIRECT_IO, 0
}
func (n *Node) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if !n.client.acquireHandle() {
		return nil, 0, syscall.EMFILE
	}
	opened := false
	defer func() {
		if !opened {
			n.client.releaseHandle()
		}
	}()
	result, code := n.client.read(ctx, n.ID())
	if code != 0 {
		return nil, 0, code
	}
	trace("open id=%s flags=%d", n.ID(), flags)
	if len(result.Content) > MaxFileBytes {
		return nil, 0, syscall.EFBIG
	}
	n.client.remember(result.Entry)
	h := &Handle{node: n, item: result.Entry, body: result.Content, writable: flags&syscall.O_ACCMODE != syscall.O_RDONLY}
	if h.writable {
		if version, ok := n.client.observedVersion(h.item.ID); ok {
			h.item.VersionID = &version
		}
	}
	if flags&syscall.O_TRUNC != 0 {
		if code := h.resize(ctx, 0); code != 0 {
			return nil, 0, code
		}
	}
	n.track(ctx, h)
	opened = true
	return h, fuse.FOPEN_DIRECT_IO, 0
}
func (n *Node) remove(ctx context.Context, name string, isDir bool) syscall.Errno {
	listing, code := n.client.list(ctx, n.ID())
	if code != 0 {
		return code
	}
	for _, item := range listing.Entries {
		if item.Name == name {
			if isDir && item.Kind != "directory" {
				return syscall.ENOTDIR
			}
			if !isDir && item.Kind == "directory" {
				return syscall.EISDIR
			}
			_, code := n.client.operation(ctx, map[string]any{"type": "trash", "entryId": item.ID, "expectedRevision": item.Revision})
			return code
		}
	}
	return syscall.ENOENT
}
func (n *Node) Unlink(ctx context.Context, name string) syscall.Errno {
	return n.remove(ctx, name, false)
}
func (n *Node) Rmdir(ctx context.Context, name string) syscall.Errno {
	return n.remove(ctx, name, true)
}
func (n *Node) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	parent, ok := newParent.(*Node)
	if !ok || parent.client != n.client {
		return syscall.EXDEV
	}
	if flags != 0 && flags != 1 {
		return syscall.EOPNOTSUPP
	} // RENAME_NOREPLACE only
	listing, code := n.client.list(ctx, n.ID())
	if code != 0 {
		return code
	}
	var source *Entry
	for i := range listing.Entries {
		if listing.Entries[i].Name == name {
			source = &listing.Entries[i]
			break
		}
	}
	if source == nil {
		return syscall.ENOENT
	}
	destination, code := n.client.list(ctx, parent.ID())
	if code != 0 {
		return code
	}
	command := map[string]any{"type": "move", "entryId": source.ID, "expectedRevision": source.Revision, "parentId": parent.ID(), "name": newName}
	for _, target := range destination.Entries {
		if target.Name == newName && target.ID != source.ID {
			if flags == 1 {
				return syscall.EEXIST
			}
			version, observed := n.client.observedVersion(target.ID)
			if !observed {
				return syscall.ESTALE
			}
			command["targetId"] = target.ID
			command["expectedTargetVersion"] = version
		}
	}
	result, code := n.client.operation(ctx, command)
	if code != 0 {
		return code
	}
	if result.Entry == nil {
		return syscall.EIO
	}
	if child := n.GetChild(name); child != nil {
		if node, ok := child.Operations().(*Node); ok {
			node.setID(result.Entry.ID)
		}
	}
	n.client.committed(*result.Entry)
	return 0
}
func (n *Node) Setattr(ctx context.Context, handle fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	trace("setattr id=%s handle=%p valid=%d size=%d", n.ID(), handle, in.Valid, in.Size)
	// Ownership, executable bits and arbitrary timestamps are not writable
	// metadata. Real file modification times come from committed service writes.
	if _, ok := in.GetUID(); ok {
		return syscall.EPERM
	}
	if _, ok := in.GetGID(); ok {
		return syscall.EPERM
	}
	if value, ok := in.GetMode(); ok && value&0777 != 0600 && value&0777 != 0700 {
		return syscall.EPERM
	}
	if size, ok := in.GetSize(); ok {
		if size > MaxFileBytes {
			return syscall.EFBIG
		}
		if handle == nil && in.Valid&(1<<9) != 0 { // FATTR_OPEN, not an independent truncate(2)
			pending := n.opening(ctx)
			if pending == nil {
				return syscall.ESTALE
			}
			handle = pending
		}
		if h, ok := handle.(*Handle); ok {
			h.mu.Lock()
			code := h.resize(ctx, size)
			h.mu.Unlock()
			if code != 0 {
				return code
			}
		} else {
			opened, _, code := n.Open(ctx, syscall.O_RDWR)
			if code != 0 {
				return code
			}
			h := opened.(*Handle)
			if code = h.resize(ctx, size); code == 0 {
				code = h.Flush(ctx)
			}
			_ = h.Release(ctx)
			if code != 0 {
				return code
			}
		}
	}
	return n.Getattr(ctx, handle, out)
}
func (n *Node) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, syscall.EPERM
}
func (n *Node) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, syscall.EPERM
}
func (n *Node) Mknod(ctx context.Context, name string, mode, dev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, syscall.EPERM
}
func (n *Node) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	list, code := n.client.list(ctx, "root")
	if code != 0 {
		return code
	}
	out.Bsize = 4096
	out.Frsize = 4096
	out.Blocks = list.Quota / 4096
	if list.Used+list.Reserved < list.Quota {
		out.Bfree = (list.Quota - list.Used - list.Reserved) / 4096
		out.Bavail = out.Bfree
	}
	out.NameLen = 255
	return 0
}

type Handle struct {
	mu              sync.Mutex
	node            *Node
	item            Entry
	body            []byte
	writable, dirty bool
	writeID         string
	failed          syscall.Errno
	released        bool
	pid             uint32
}

func (h *Handle) check(ctx context.Context) syscall.Errno {
	_, code := h.node.client.stat(ctx, h.item.ID)
	return code
}
func (h *Handle) reserve(ctx context.Context, size uint64) syscall.Errno {
	if !h.writable {
		return syscall.EBADF
	}
	if h.failed != 0 {
		return h.failed
	}
	if h.writeID == "" {
		result, code := h.node.client.operation(ctx, map[string]any{"type": "begin-write", "entryId": h.item.ID, "expectedVersion": h.item.VersionID})
		if code != 0 {
			return code
		}
		if result.Write == nil {
			return syscall.EIO
		}
		h.writeID = result.Write.ID
	}
	_, code := h.node.client.operation(ctx, map[string]any{"type": "reserve-write", "writeId": h.writeID, "size": size})
	return code
}
func (h *Handle) resize(ctx context.Context, size uint64) syscall.Errno {
	if size > MaxFileBytes {
		return syscall.EFBIG
	}
	if code := h.reserve(ctx, size); code != 0 {
		return code
	}
	if size <= uint64(len(h.body)) {
		h.body = h.body[:size]
	} else {
		h.body = append(h.body, make([]byte, int(size)-len(h.body))...)
	}
	h.dirty = true
	return 0
}
func (h *Handle) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	if code := h.check(ctx); code != 0 {
		return nil, code
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
func (h *Handle) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	if off < 0 || off > MaxFileBytes || int64(len(data)) > MaxFileBytes-off {
		return 0, syscall.EFBIG
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	size := len(h.body)
	if end := int(off) + len(data); end > size {
		size = end
	}
	if code := h.reserve(ctx, uint64(size)); code != 0 {
		return 0, code
	}
	if size > len(h.body) {
		h.body = append(h.body, make([]byte, size-len(h.body))...)
	}
	copy(h.body[off:], data)
	h.dirty = true
	return uint32(len(data)), 0
}
func (h *Handle) Flush(ctx context.Context) syscall.Errno {
	if code := h.check(ctx); code != 0 {
		return code
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.failed != 0 || !h.dirty {
		return h.failed
	}
	result, code := h.node.client.operation(ctx, map[string]any{"type": "commit-write", "writeId": h.writeID, "content": bytes.Clone(h.body)})
	trace("flush id=%s handle=%p size=%d code=%d conflict=%v", h.item.ID, h, len(h.body), code, result.Conflict)
	if result.Conflict {
		h.writeID = ""
		h.failed = syscall.ESTALE
		return h.failed
	}
	if code != 0 {
		h.failed = code
		return code
	}
	if result.Entry == nil {
		return syscall.EIO
	}
	h.item = *result.Entry
	h.node.client.committed(h.item)
	h.writeID = ""
	h.dirty = false
	return 0
}
func (h *Handle) Fsync(ctx context.Context, flags uint32) syscall.Errno { return h.Flush(ctx) }
func (h *Handle) Release(ctx context.Context) syscall.Errno {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.released {
		return 0
	}
	h.released = true
	defer h.node.client.releaseHandle()
	h.body = nil
	h.node.forget(h)
	if h.writeID != "" {
		_, _ = h.node.client.operation(ctx, map[string]any{"type": "abort-write", "writeId": h.writeID})
		h.writeID = ""
	}
	return 0
}

func Mount(dir string, client *Client) (*fuse.Server, error) {
	zero := time.Duration(0)
	return fs.Mount(dir, &Node{client: client, id: "root"}, &fs.Options{
		MountOptions: fuse.MountOptions{Name: "cumora-project", FsName: "cumora-project", DirectMountStrict: true,
			DirectMountFlags: syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC, DisableXAttrs: true},
		EntryTimeout: &zero, AttrTimeout: &zero, NegativeTimeout: &zero,
	})
}
