//go:build linux

// Package projectfs mounts the shared project API. It never receives the private
// object path or a general Agent runtime credential.
package projectfs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
)

const MaxFileBytes = 25 * 1024 * 1024

type Entry struct {
	ID         string  `json:"id"`
	ParentID   *string `json:"parentId"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Revision   string  `json:"revision"`
	VersionID  *string `json:"versionId"`
	Size       uint64  `json:"size"`
	ModifiedAt string  `json:"modifiedAt"`
}
type listing struct {
	Entries  []Entry `json:"entries"`
	Quota    uint64  `json:"quotaBytes"`
	Used     uint64  `json:"usedBytes"`
	Reserved uint64  `json:"reservedBytes"`
}
type readResult struct {
	Entry   Entry  `json:"entry"`
	Content []byte `json:"content"`
}
type writeSession struct {
	ID              string  `json:"id"`
	ExpectedVersion *string `json:"expectedVersion"`
}
type operationResult struct {
	Entry    *Entry        `json:"entry"`
	Write    *writeSession `json:"write"`
	Conflict bool          `json:"conflict"`
	Code     string        `json:"code"`
}
type Client struct {
	base, token, project string
	http                 *http.Client
	mu                   sync.Mutex
	observed             map[string]string
	handles              int
}

func (c *Client) acquireHandle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handles >= 8 {
		return false
	}
	c.handles++
	return true
}
func (c *Client) releaseHandle() { c.mu.Lock(); defer c.mu.Unlock(); c.handles-- }
func NewClient(server, project, token string) *Client {
	return &Client{base: strings.TrimRight(server, "/") + "/project-fs/", project: url.PathEscape(project), token: token,
		http: &http.Client{Timeout: 15 * time.Second}, observed: make(map[string]string)}
}
func requestID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", id[:])
}
func (c *Client) call(ctx context.Context, method, path string, input, output any) syscall.Errno {
	// FUSE_INTERRUPT includes ordinary Go SIGURG preemption. Finish the
	// bounded API request rather than cancel a possibly committed mutation
	// and report a spurious EIO. Lease checks still run on every API call;
	// task shutdown terminates the whole mount process. Heartbeat contexts
	// are not FUSE contexts and retain their cancellation/deadline.
	if _, ok := ctx.(*fuse.Context); ok {
		ctx = context.WithoutCancel(ctx)
	}
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return syscall.EINVAL
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return syscall.EIO
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		trace("request failed method=%s path=%s error=%v", method, path, err)
		return syscall.EIO
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 36*1024*1024))
	if err != nil {
		return syscall.EIO
	}
	if output != nil && json.Unmarshal(data, output) != nil {
		trace("invalid response method=%s path=%s status=%d", method, path, res.StatusCode)
		return syscall.EIO
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return 0
	}
	var problem struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(data, &problem)
	trace("operation failed method=%s path=%s status=%d code=%s", method, path, res.StatusCode, problem.Code)
	switch problem.Code {
	case "NOT_FOUND", "CONTENT_MISSING":
		return syscall.ENOENT
	case "REVOKED", "ADMIN_REQUIRED", "UNAUTHENTICATED":
		return syscall.EACCES
	case "CONFLICT", "BINDING_CHANGED", "WRITE_EXPIRED":
		return syscall.ESTALE
	case "QUOTA_EXCEEDED", "ENTRY_LIMIT", "VERSION_LIMIT", "HOST_DISK_FULL":
		return syscall.ENOSPC
	case "FILE_TOO_LARGE":
		return syscall.EFBIG
	case "ALREADY_EXISTS":
		return syscall.EEXIST
	case "DIRECTORY_NOT_EMPTY":
		return syscall.ENOTEMPTY
	case "NOT_DIRECTORY":
		return syscall.ENOTDIR
	case "IS_DIRECTORY":
		return syscall.EISDIR
	case "READ_ONLY":
		return syscall.EROFS
	case "WRITE_PENDING", "TOO_MANY_WRITES":
		return syscall.EBUSY
	case "INVALID_NAME", "DIRECTORY_CYCLE", "DEPTH_LIMIT":
		return syscall.EINVAL
	}
	if res.StatusCode == 409 {
		return syscall.ESTALE
	}
	if res.StatusCode == 403 || res.StatusCode == 401 {
		return syscall.EACCES
	}
	if res.StatusCode == 404 {
		return syscall.ENOENT
	}
	return syscall.EIO
}
func (c *Client) list(ctx context.Context, id string) (listing, syscall.Errno) {
	var out listing
	e := c.call(ctx, "GET", c.project+"/list?parentId="+url.QueryEscape(id), nil, &out)
	return out, e
}
func (c *Client) stat(ctx context.Context, id string) (Entry, syscall.Errno) {
	var out Entry
	e := c.call(ctx, "GET", c.project+"/stat/"+url.PathEscape(id), nil, &out)
	return out, e
}
func (c *Client) read(ctx context.Context, id string) (readResult, syscall.Errno) {
	var out readResult
	e := c.call(ctx, "GET", c.project+"/read/"+url.PathEscape(id), nil, &out)
	return out, e
}
func (c *Client) operation(ctx context.Context, command map[string]any) (operationResult, syscall.Errno) {
	var out operationResult
	e := c.call(ctx, "POST", c.project+"/operations", map[string]any{"requestId": requestID(), "command": command}, &out)
	return out, e
}
func (c *Client) remember(item Entry) {
	if item.VersionID == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.observed[item.ID]; !exists {
		c.observed[item.ID] = *item.VersionID
	}
}
func (c *Client) committed(item Entry) {
	if item.VersionID == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observed[item.ID] = *item.VersionID
}
func (c *Client) observedVersion(id string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	version, ok := c.observed[id]
	return version, ok
}
func (c *Client) Heartbeat(ctx context.Context) syscall.Errno {
	return c.call(ctx, "POST", "heartbeat", map[string]any{}, nil)
}
