#!/bin/zsh
# OWNER: N0
# The device lock (IOS-SPEC-QWEN §7.2 rule 7): one device operation at a time on his iPhone, across every agent.
#   Tools/device-lock.sh status                              prints the holder; exit 0 free · 1 held
#   Tools/device-lock.sh acquire <task> [--wait S]           takes the lock and prints its token; exit 0 taken · 3 held by
#                                                            someone else after S seconds (PENDING_DEVICE)
#   Tools/device-lock.sh release <task|token>                removes the lock if that task holds it; exit 0 · 1 held by another
#   Tools/device-lock.sh run <task> [--wait S] -- <cmd…>     acquire, run the command, release (also on error, INT and TERM);
#                                                            exit = the command's, or 3 (PENDING_DEVICE)
#   Tools/device-lock.sh break [reason]                      removes any lock (a person clearing a wedged holder); logged
#   Tools/device-lock.sh selftest                            exercises every rule above on a scratch lock (never the real one)
# The lock is the file ~/Developer/scrolls-build/.device.lock (SCROLLS_DEVICE_LOCK), one key=value per line:
#   holder (SCROLLS_AGENT) · task · started (UTC) · epoch · pid (the `run` process; for a bare `acquire`,
#   SCROLLS_DEVICE_LOCK_PID, e.g. the caller's $$, or empty) · boot
#   (kern.boottime seconds) · token
# Held also means: a `build.sh install` outside this process's own chain that is already talking to the device (it has a
# devicectl descendant and no device-lock.sh descendant), i.e. an install started by an older build.sh without the lock.
# Stale (taken over, with a line in .device.lock.log): the Mac rebooted since (boot differs), the recorded pid is dead, or
# the lock is older than SCROLLS_DEVICE_LOCK_MAX_AGE (default 14400 s).
# Re-entry: a process whose SCROLLS_DEVICE_LOCK_TOKEN is the lock's token (`run` exports it to its command), or whose
# SCROLLS_TASK is the lock's task, proceeds without taking the lock again and never releases it.
# Waiting: --wait S, else SCROLLS_DEVICE_LOCK_WAIT, else 900 s (the ~15 min retry of §7.2), polling every
# SCROLLS_DEVICE_LOCK_POLL (15) s. A wait that ends with the lock still held is PENDING_DEVICE, never PASS.
set -uo pipefail
zmodload zsh/datetime
LOCK="${SCROLLS_DEVICE_LOCK:-$HOME/Developer/scrolls-build/.device.lock}"
LOG="$LOCK.log"
MUTEX="$LOCK.mutex"
MAX_AGE="${SCROLLS_DEVICE_LOCK_MAX_AGE:-14400}"
POLL="${SCROLLS_DEVICE_LOCK_POLL:-15}"
mkdir -p "${LOCK:h}"

# Under the loads this Mac runs at (300-900), every spawned process costs; the lock is read with builtins only.
BOOT="$(sysctl -n kern.boottime)"; [[ "$BOOT" =~ '^\{ sec = ([0-9]+),' ]] && BOOT="$match[1]"
now_utc() { TZ=UTC strftime '%Y-%m-%dT%H:%M:%SZ' "$EPOCHSECONDS"; }
log() { print -r -- "$(now_utc) $*" >> "$LOG"; }
typeset -A L
load() {  # the lock's fields into L; 1 when there is no lock
  L=()
  [[ -f "$LOCK" ]] || return 1
  local k v
  while IFS='=' read -r k v; do [[ -n "$k" ]] && L[$k]="$v"; done < "$LOCK" 2>/dev/null
  return 0
}
field() { load && print -r -- "${L[$1]:-}"; }

# a short critical section around read-check-write (builtins only); a mutex held 30 s is a crashed holder's and is removed
mutex_take() {
  local t0=$SECONDS
  until mkdir "$MUTEX" 2>/dev/null; do
    if (( SECONDS - t0 > 30 )); then rm -rf "$MUTEX"; t0=$SECONDS; fi
    sleep 0.2
  done
}
mutex_drop() { rmdir "$MUTEX" 2>/dev/null; }

ancestors() {
  local p=$$
  while [[ -n "$p" && "$p" -gt 1 ]]; do print -r -- "$p"; p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; done
}
descendant_cmds() {  # the command lines of every descendant of $1
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do ps -o command= -p "$c" 2>/dev/null; descendant_cmds "$c"; done
}
foreign_install() {  # a pid of a lock-unaware `build.sh install` already on the device, or nothing
  # one pgrep when no install runs; the ancestry walk (a ps per level, seconds at load 900) only when one does
  local -a cand anc; cand=( $(pgrep -f "build.sh install" 2>/dev/null) )
  (( ${#cand} )) || return 0
  anc=( $(ancestors) )
  local p d
  for p in $cand; do
    (( ${anc[(Ie)$p]} )) && continue
    d="$(descendant_cmds "$p")"
    [[ "$d" == *device-lock.sh* ]] && continue   # lock-aware: the lock file decides
    [[ "$d" == *devicectl* ]] || continue        # still building: not on the device yet
    print -r -- "$p"; return 0
  done
}

# prints why the current lock is stale, or nothing when it is live (or absent)
stale_reason() {
  load || return 0
  local pid="${L[pid]:-}" age=$(( EPOCHSECONDS - ${L[epoch]:-0} ))
  if [[ "${L[boot]:-}" != "$BOOT" ]]; then print -r -- "the Mac rebooted since it was taken (boot ${L[boot]:-?}, now $BOOT)"; return 0; fi
  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then print -r -- "its process $pid is gone"; return 0; fi
  if (( age > MAX_AGE )); then print -r -- "older than $MAX_AGE s ($age s)"; return 0; fi
}

describe() {
  load || { print -r -- "free"; return; }
  print -r -- "held by ${L[holder]:-?} for task ${L[task]:-?} since ${L[started]:-?} (pid ${L[pid]:-none}); $LOCK"
}

reentrant() {
  load || return 1
  [[ -n "${SCROLLS_DEVICE_LOCK_TOKEN:-}" && "${SCROLLS_DEVICE_LOCK_TOKEN}" == "${L[token]:-}" ]] && return 0
  [[ -n "${SCROLLS_TASK:-}" && "${SCROLLS_TASK}" == "${L[task]:-}" ]] && return 0
  return 1
}

# one attempt: 0 taken (token on stdout) · 1 held (reason on stderr)
try_take() {
  local task="$1" pid="$2" why foreign token tmp
  # the process scan spawns ps/pgrep, so it runs before the critical section, never inside it
  if [[ ! -f "$LOCK" ]]; then
    foreign="$(foreign_install)"
    if [[ -n "$foreign" ]]; then
      print -r -- "an install without the lock is on the device: $(ps -o command= -p "$foreign" | cut -c1-160) (pid $foreign)" >&2
      return 1
    fi
  fi
  mutex_take
  why="$(stale_reason)"
  if [[ -n "$why" ]]; then
    log "takeover task=$task stale: $why; was: ${(j: :)${(f)"$(<$LOCK)"}}"
    rm -f "$LOCK"
  fi
  if [[ -f "$LOCK" ]]; then mutex_drop; print -r -- "$(describe)" >&2; return 1; fi
  token="$task.$$.$RANDOM$EPOCHSECONDS"
  tmp="$LOCK.tmp.$$"
  print -r -- "holder=${SCROLLS_AGENT:-unknown}
task=$task
started=$(now_utc)
epoch=$EPOCHSECONDS
pid=$pid
boot=$BOOT
token=$token" > "$tmp" && mv -f "$tmp" "$LOCK"
  mutex_drop
  log "acquire task=$task holder=${SCROLLS_AGENT:-unknown} pid=$pid token=$token"
  print -r -- "$token"
}

# waits up to $2 s; 0 taken (token on stdout) · 3 still held
take_waiting() {
  local task="$1" wait="$2" pid="$3" t0=$SECONDS err
  while true; do
    if try_take "$task" "$pid" 2> "$LOCK.err.$$"; then rm -f "$LOCK.err.$$"; return 0; fi
    err="$(cat "$LOCK.err.$$")"; rm -f "$LOCK.err.$$"
    if (( SECONDS - t0 >= wait )); then
      print -r -- "PENDING_DEVICE  device lock for $task: $err (waited $(( SECONDS - t0 )) s)" >&2
      log "pending task=$task after $(( SECONDS - t0 )) s: $err"
      return 3
    fi
    print -r -- "device-lock: waiting for $task: $err" >&2
    sleep "$POLL"
  done
}

release() {
  local who="$1"
  mutex_take
  if [[ ! -f "$LOCK" ]]; then mutex_drop; return 0; fi
  load
  if [[ "${L[task]:-}" == "$who" || "${L[token]:-}" == "$who" ]]; then
    log "release task=${L[task]:-} token=${L[token]:-}"
    rm -f "$LOCK"; mutex_drop; return 0
  fi
  mutex_drop
  print -r -- "device-lock: not released: $(describe) (asked by '$who')" >&2
  return 1
}

parse_wait() {  # sets WAIT and REST from "[--wait S] …"
  WAIT="${SCROLLS_DEVICE_LOCK_WAIT:-900}"; REST=( "$@" )
  if [[ "${REST[1]:-}" == --wait ]]; then WAIT="${REST[2]:?--wait needs seconds}"; REST=( "${REST[@]:2}" ); fi
}

cmd="${1:-status}"; (( $# )) && shift
case "$cmd" in
  status)
    why="$(stale_reason)"; [[ -n "$why" ]] && print -r -- "$(describe) — stale: $why" && exit 0
    print -r -- "$(describe)"; [[ -f "$LOCK" ]] && exit 1; exit 0 ;;
  acquire)
    task="${1:?usage: device-lock.sh acquire <task> [--wait S]}"; shift
    parse_wait "$@"
    if reentrant; then print -r -- "${L[token]}"; exit 0; fi
    take_waiting "$task" "$WAIT" "${SCROLLS_DEVICE_LOCK_PID:-}" ;;
  release)
    release "${1:?usage: device-lock.sh release <task|token>}" ;;
  run)
    task="${1:?usage: device-lock.sh run <task> [--wait S] -- <command…>}"; shift
    parse_wait "$@"; set -- "${REST[@]}"
    [[ "${1:-}" == -- ]] && shift
    (( $# )) || { print -r -- "device-lock.sh run: no command" >&2; exit 2; }
    if reentrant; then "$@"; exit $?; fi
    token="$(take_waiting "$task" "$WAIT" "$$")" || exit 3
    trap 'release "$token" >/dev/null 2>&1' EXIT
    # zsh runs a trap only after a foreground child exits, so the command runs as a child we `wait` for: INT and TERM then
    # release the lock at once (measured: a TERM during a foreground `sleep 5` was handled 5 s late)
    SCROLLS_DEVICE_LOCK_TOKEN="$token" "$@" &
    child=$!
    trap 'kill -INT $child 2>/dev/null; exit 130' INT
    trap 'kill -TERM $child 2>/dev/null; exit 143' TERM
    wait $child
    exit $? ;;
  break)
    mutex_take
    [[ -f "$LOCK" ]] && log "break (${1:-no reason}); was: ${(j: :)${(f)"$(<$LOCK)"}}"
    rm -f "$LOCK"; mutex_drop
    print -r -- "device-lock: cleared" ;;
  selftest)
    # every case on a scratch lock; prints one line per case and exits 1 if any fails
    SECONDS=0; T="$(mktemp -d "${TMPDIR:-/tmp}/device-lock-selftest.XXXXXX")"
    export SCROLLS_DEVICE_LOCK="$T/.device.lock" SCROLLS_DEVICE_LOCK_POLL=1 SCROLLS_AGENT=selftest
    unset SCROLLS_DEVICE_LOCK_TOKEN SCROLLS_TASK SCROLLS_DEVICE_LOCK_PID
    me="$0"; fails=0; n=0
    check() {  # check <name> <expected exit> <actual exit> [extra condition result 0/1]
      (( n++ ))
      if [[ "$2" == "$3" && "${4:-0}" == 0 ]]; then print -r -- "PASS  $1"; else print -r -- "FAIL  $1 (exit $3, expected $2${4:+, condition $4})"; (( fails++ )); fi
    }
    "$me" status >/dev/null; check "status on no lock: free (exit 0)" 0 $?
    tokA="$("$me" acquire A --wait 0 2>/dev/null)"; check "acquire A: taken, token printed" 0 $? $([[ "$tokA" == A.* ]]; print $?)
    "$me" status >/dev/null; check "status while A holds: held (exit 1)" 1 $?
    "$me" acquire B --wait 0 >/dev/null 2>"$T/b.err"; rc=$?
    check "acquire B while A holds, no wait: PENDING_DEVICE (exit 3)" 3 $rc $(grep -q PENDING_DEVICE "$T/b.err"; print $?)
    "$me" release B >/dev/null 2>&1; check "release by a task that does not hold it: refused (exit 1)" 1 $?
    SCROLLS_DEVICE_LOCK_TOKEN="$tokA" "$me" run A2 --wait 0 -- true; rc=$?
    "$me" status >/dev/null; check "re-entry by token: command runs, lock still A's" 0 $rc $([[ $? == 1 && "$(grep '^task=' $SCROLLS_DEVICE_LOCK)" == task=A ]]; print $?)
    SCROLLS_TASK=A "$me" acquire A3 --wait 0 >/dev/null 2>&1; check "re-entry by SCROLLS_TASK: no second lock" 0 $?
    ( sleep 2; "$me" release "$tokA" >/dev/null ) &
    tokB="$("$me" acquire B --wait 20 2>/dev/null)"; rc=$?; wait
    check "acquire B waits for A's release, then takes it" 0 $rc $([[ "$tokB" == B.* ]]; print $?)
    "$me" release B >/dev/null; "$me" status >/dev/null; check "release B: free" 0 $?
    "$me" run C --wait 0 -- false; rc=$?
    "$me" status >/dev/null; check "run: the command's exit code (1), lock released after a failure" 1 $rc $(( $? ))
    "$me" run D --wait 0 -- sleep 60 & runpid=$!
    held=0; t0=$SECONDS; until (( held == 1 || SECONDS - t0 > 60 )); do sleep 1; "$me" status >/dev/null; held=$?; done
    kill -TERM $runpid; wait $runpid; rc=$?; sleep 0.5
    "$me" status >/dev/null; check "run under TERM: held while running, exit 143, released at once" 143 $rc $(( held != 1 || $? != 0 ))
    print -l -- holder=x task=old started=x "epoch=$EPOCHSECONDS" "pid=" "boot=1" token=old.1 > "$SCROLLS_DEVICE_LOCK"
    "$me" acquire E --wait 0 >/dev/null 2>&1; rc=$?
    check "a lock from before a reboot is stale: taken over, logged" 0 $rc $(grep -q 'takeover task=E stale: the Mac rebooted' "$SCROLLS_DEVICE_LOCK.log"; print $?)
    "$me" release E >/dev/null
    zsh -c 'exit 0' & dead=$!; wait $dead
    print -l -- holder=x task=old started=x "epoch=$EPOCHSECONDS" "pid=$dead" "boot=$BOOT" token=old.2 > "$SCROLLS_DEVICE_LOCK"
    "$me" acquire F --wait 0 >/dev/null 2>&1; rc=$?
    check "a lock whose process is gone is stale: taken over" 0 $rc $(grep -q "takeover task=F stale: its process $dead is gone" "$SCROLLS_DEVICE_LOCK.log"; print $?)
    "$me" release F >/dev/null
    print -l -- holder=x task=old started=x "epoch=$(( EPOCHSECONDS - 20000 ))" "pid=" "boot=$BOOT" token=old.3 > "$SCROLLS_DEVICE_LOCK"
    "$me" acquire G --wait 0 >/dev/null 2>&1; check "a lock older than the maximum age is stale: taken over" 0 $?
    "$me" release G >/dev/null
    SCROLLS_DEVICE_LOCK_PID=$$ "$me" acquire H --wait 0 >/dev/null 2>&1; rc=$?
    check "acquire with SCROLLS_DEVICE_LOCK_PID records the caller's pid" 0 $rc $([[ "$(grep '^pid=' $SCROLLS_DEVICE_LOCK)" == "pid=$$" ]]; print $?)
    "$me" release H >/dev/null
    # an older lock-unaware `build.sh install` already talking to the device (a child named devicectl) holds the device
    zsh -c '(exec -a devicectl sleep 20); :' build.sh install & fake=$!; sleep 1
    "$me" acquire I --wait 0 >/dev/null 2>"$T/i.err"; rc=$?
    check "a lock-unaware build.sh install on the device counts as held" 3 $rc $(grep -q 'an install without the lock' "$T/i.err"; print $?)
    kill $fake 2>/dev/null; pkill -f '^devicectl 20$' 2>/dev/null; wait $fake 2>/dev/null
    "$me" break selftest >/dev/null; "$me" status >/dev/null; check "break: free" 0 $?
    print -r -- "device-lock selftest: $(( n - fails ))/$n PASS in $SECONDS s, load $(sysctl -n vm.loadavg) (scratch lock $SCROLLS_DEVICE_LOCK)"
    rm -rf "$T"
    (( fails == 0 )) ;;
  *) print -r -- "usage: device-lock.sh status|acquire <task> [--wait S]|release <task|token>|run <task> [--wait S] -- <cmd…>|break [reason]|selftest" >&2; exit 2 ;;
esac
