//go:build linux

// Trusted task supervisor. Configuration arrives through fd 3, never argv/env.
// All paths in Config come from the host daemon, not from an LLM or file name.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cumora/agent-fuse/projectfs"
)

type Config struct {
	Root         string            `json:"root"`
	Home         string            `json:"home"`
	Enter        string            `json:"enter"`
	Server       string            `json:"server"`
	Project      string            `json:"project"`
	Token        string            `json:"token"`
	Env          map[string]string `json:"env"`
	AllowedPorts []uint16          `json:"allowedPorts"`
	// Extra readonly runtime directories (e.g. an engine installed outside /usr).
	RuntimeDirs []string `json:"runtimeDirs"`
}

func readConfig() (Config, error) {
	var config Config
	file := os.NewFile(3, "task-config")
	if file == nil {
		return config, errors.New("missing configuration descriptor")
	}
	defer file.Close()
	err := json.NewDecoder(io.LimitReader(file, 1024*1024)).Decode(&config)
	return config, err
}
func configPipe(config Config) (*os.File, error) {
	read, write, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	go func() { defer write.Close(); _ = json.NewEncoder(write).Encode(config) }()
	return read, nil
}
func bind(source, target string, readonly bool) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if info.IsDir() {
		err = os.MkdirAll(target, 0755)
	} else {
		if err = os.MkdirAll(filepath.Dir(target), 0755); err == nil {
			var f *os.File
			f, err = os.OpenFile(target, os.O_CREATE|os.O_WRONLY, 0600)
			if err == nil {
				err = f.Close()
			}
		}
	}
	if err != nil {
		return err
	}
	if err = syscall.Mount(source, target, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return err
	}
	flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_NOSUID)
	if readonly {
		flags |= syscall.MS_RDONLY
	}
	return syscall.Mount("", target, "", flags, "")
}
func setup(config Config) error {
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return err
	}
	if err := syscall.Mount("tmpfs", config.Root, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "size=256m,mode=0755"); err != nil {
		return err
	}
	for _, dir := range []string{"usr", "bin", "sbin", "lib", "lib64"} {
		source := "/" + dir
		if _, err := os.Stat(source); err == nil {
			if err := bind(source, filepath.Join(config.Root, dir), true); err != nil {
				return err
			}
		}
	}
	for _, source := range []string{"/etc/ssl", "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/fonts"} {
		if _, err := os.Stat(source); err == nil {
			if err := bind(source, filepath.Join(config.Root, source), true); err != nil {
				return err
			}
		}
	}
	for _, dir := range []string{"proc", "tmp", "dev", "home/agent", "projects"} {
		if err := os.MkdirAll(filepath.Join(config.Root, dir), 0755); err != nil {
			return err
		}
	}
	for _, name := range []string{"null", "zero", "random", "urandom"} {
		if err := bind("/dev/"+name, filepath.Join(config.Root, "dev", name), false); err != nil {
			return err
		}
	}
	if err := os.Symlink("/proc/self/fd", filepath.Join(config.Root, "dev/fd")); err != nil {
		return err
	}
	if err := bind(config.Home, filepath.Join(config.Root, "home/agent"), false); err != nil {
		return err
	}
	for _, dir := range config.RuntimeDirs {
		if !filepath.IsAbs(dir) || dir == "/" || strings.HasPrefix(dir, "/proc") || strings.HasPrefix(dir, "/workspace") {
			return errors.New("unsafe runtime directory")
		}
		if err := bind(dir, filepath.Join(config.Root, dir), true); err != nil {
			return err
		}
	}
	return nil
}

func run(config Config, argv []string, inner bool) (int, error) {
	if !inner {
		if !filepath.IsAbs(config.Home) || !filepath.IsAbs(config.Enter) {
			return 125, errors.New("absolute task home and enter helper required")
		}
		root, err := os.MkdirTemp("", "cumora-task-root-")
		if err != nil {
			return 125, err
		}
		defer os.Remove(root)
		config.Root = root
		self, err := os.Executable()
		if err != nil {
			return 125, err
		}
		pipe, err := configPipe(config)
		if err != nil {
			return 125, err
		}
		defer pipe.Close()
		child := exec.Command(self, append([]string{"--inner"}, argv...)...)
		child.ExtraFiles = []*os.File{pipe}
		child.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWNS | syscall.CLONE_NEWPID,
			UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
			GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}, GidMappingsEnableSetgroups: false, Pdeathsig: syscall.SIGKILL}
		return supervise(child, nil)
	}
	if err := setup(config); err != nil {
		return 125, fmt.Errorf("task filesystem setup: %w", err)
	}
	var client *projectfs.Client
	if config.Project != "" {
		for _, ch := range config.Project {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
				return 125, errors.New("invalid project identifier")
			}
		}
		mount := filepath.Join(config.Root, "projects", config.Project)
		if err := os.Mkdir(mount, 0700); err != nil {
			return 125, err
		}
		client = projectfs.NewClient(config.Server, config.Project, config.Token)
		if code := client.Heartbeat(context.Background()); code != 0 {
			return 125, fmt.Errorf("project lease rejected: %v", code)
		}
		server, err := projectfs.Mount(mount, client)
		if err != nil {
			return 125, err
		}
		defer server.Unmount()
	}
	ports := []string{"80", "443", "53"}
	for _, port := range config.AllowedPorts {
		if port > 0 {
			ports = append(ports, strconv.Itoa(int(port)))
		}
	}
	args := append([]string{config.Root, "/home/agent", strings.Join(ports, ",")}, argv...)
	child := exec.Command(config.Enter, args...)
	child.Env = []string{"PATH=/home/agent/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/home/agent", "TMPDIR=/tmp", "LANG=C.UTF-8"}
	for key, value := range config.Env {
		if key == "HOME" || key == "TMPDIR" || key == "LD_PRELOAD" || key == "LD_LIBRARY_PATH" || strings.ContainsAny(key, "=\x00") {
			continue
		}
		child.Env = append(child.Env, key+"="+value)
	}
	child.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS | syscall.CLONE_NEWPID, Pdeathsig: syscall.SIGKILL}
	return supervise(child, client)
}
func supervise(child *exec.Cmd, client *projectfs.Client) (int, error) {
	parent := os.Getppid()
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		return 125, err
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var killed <-chan time.Time
	stop := func() {
		_ = child.Process.Signal(syscall.SIGTERM)
		if killed == nil {
			killed = time.After(2 * time.Second)
		}
	}
	for {
		select {
		case err := <-done:
			if err == nil {
				return 0, nil
			}
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code := exit.ExitCode()
				if code < 0 {
					code = 137
				}
				return code, nil
			}
			return 125, err
		case <-signals:
			stop()
		case <-killed:
			_ = child.Process.Kill()
			killed = nil
		case <-ticker.C:
			if os.Getppid() != parent {
				stop()
			}
			if client != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				code := client.Heartbeat(ctx)
				cancel()
				if code != 0 {
					stop()
				}
			}
		}
	}
}
func main() {
	config, err := readConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "task configuration unavailable")
		os.Exit(125)
	}
	args := os.Args[1:]
	inner := len(args) > 0 && args[0] == "--inner"
	if inner {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "task executable required")
		os.Exit(125)
	}
	code, err := run(config, args, inner)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(code)
}
