// Small single-threaded final exec boundary. Built with the host C compiler.
// The caller already created an unprivileged user namespace and a PRIVATE
// mount/PID namespace. No setuid bit, sudo, privileged container or fallback.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static void die(const char *step) { perror(step); _exit(125); }
struct ll_ruleset { uint64_t fs, net, scoped; };
struct ll_port { uint64_t allowed, port; };
static void restrict_network(const char *ports) {
    int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, 1);
    if (abi < 6) { errno = ENOTSUP; die("Landlock ABI 6 required"); }
    // Deny TCP bind/connect unless explicitly allowed. Also isolate abstract
    // Unix sockets and signals from processes outside this task's domain.
    struct ll_ruleset rules = { .fs = 0, .net = 3, .scoped = 3 };
    int fd = syscall(__NR_landlock_create_ruleset, &rules, sizeof(rules), 0);
    if (fd < 0) die("landlock ruleset");
    char *copy = strdup(ports), *save = NULL;
    if (!copy) die("ports");
    for (char *p = strtok_r(copy, ",", &save); p; p = strtok_r(NULL, ",", &save)) {
        char *end = NULL;
        unsigned long port = strtoul(p, &end, 10);
        if (!end || *end || port < 1 || port > 65535) { errno = EINVAL; die("invalid allowed port"); }
        struct ll_port rule = { .allowed = 2, .port = port };
        if (syscall(__NR_landlock_add_rule, fd, 2, &rule, 0)) die("landlock port");
    }
    free(copy);
    if (syscall(__NR_landlock_restrict_self, fd, 0)) die("landlock restrict");
    close(fd);
}

#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
#if defined(__x86_64__)
    const unsigned arch = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
    const unsigned arch = AUDIT_ARCH_AARCH64;
#else
#error Unsupported architecture
#endif
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, arch, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
        DENY(__NR_open_by_handle_at), DENY(__NR_bpf), DENY(__NR_perf_event_open),
        DENY(__NR_io_uring_setup), DENY(__NR_mount), DENY(__NR_umount2),
        DENY(__NR_pivot_root), DENY(__NR_chroot), DENY(__NR_setns),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program)) die("seccomp");
}

int main(int argc, char **argv) {
    // root, cwd, allowed TCP ports, executable, arguments...
    if (argc < 5 || geteuid() != 0 || getpid() != 1) { errno = EPERM; die("isolated task init required"); }
    char proc[4096];
    int length = snprintf(proc, sizeof(proc), "%s/proc", argv[1]);
    if (length < 0 || (size_t)length >= sizeof(proc)) { errno = ENAMETOOLONG; die("root"); }
    if (mount("proc", proc, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) die("private proc");
    if (chroot(argv[1]) || chdir(argv[2])) die("task root");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
    restrict_network(argv[3]);
    if (prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED, 0, 0, 0)) die("securebits");
    for (int cap = 0; cap < 64; cap++) if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) && errno != EINVAL) die("drop capability");
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(__NR_capset, &header, data)) die("capset");
    struct rlimit core = {0, 0}, files = {256, 256}, procs = {512, 512};
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_NPROC, &procs)) die("resource limits");
    restrict_syscalls();
    // Close everything except stdin/stdout/stderr, including setup descriptors.
    if (syscall(__NR_close_range, 3, ~0U, 0)) die("close descriptors");
    execvp(argv[4], &argv[4]);
    die("exec task");
}
