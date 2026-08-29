# KRT native-auto quality and safety policy

## Authority

The managed backend uses KiCadRoutingTools `v0.21.3`. KRT owns path search,
blocker selection, rip-up/reconciliation, net rescue and terminal escalation.
The router core owns DSL semantics, compiled hard rules, protected-net custody,
candidate selection and partial-result application.

There are no public quality profiles. Production uses one `native-auto` policy
and deliberately does not override KRT's measured defaults for iteration caps,
heuristic weight, via/turn/direction costs, rip-up depth, blocker ranking or
abandon metric. This prevents a router release from silently retaining stale
copies of KRT tuning constants.

## Native recovery

The adapter explicitly enables KRT's default-on recovery capabilities so a
stale parent-process A/B environment cannot disable them:

```text
KICAD_RIP_PREEXISTING=1
KICAD_NET_RESCUE=1
KICAD_TERMINAL_ESCALATION=1
KICAD_DYNAMIC_ITERATIONS=1
KICAD_FINALIZE_RIP=1
```

Native plane finalization stays off because plane creation and refill are a
core-owned post-route operation. Pre-existing copper is rippable only when it
is editable and not protected or KiCad-locked. KRT custody must restore every
rip victim; an unrecovered victim is an error, while a successfully restored
native blocker is an informational event.

Only copper which passes the independent board-semantic constraint audit, its
connectivity audit and the per-net DRC fingerprint gate is written to
`protected_nets`. Differential custody is per pair: one failed compatible
sibling pair cannot revoke a coupled, connected, DRC-clean pair. If a pair also
belongs to a matched group, that exact group's semantic audit must pass before
the pair earns custody. Incomplete or semantically unverified special copper
remains a usable partial checkpoint but is not frozen, so the main pass may
recover its space. Differential single-ended follow-up protects the coupled
trunk while attempting its remaining short branches.

Ordinary `priority: "critical"` groups run before the full-board pass. Each
member is protected independently only when the outer full-board geometry audit
proves it connected and its attributed DRC identities do not regress. A timeout
or non-zero process exit remains visible but does not revoke independently
verified copper. A partially completed critical group therefore keeps verified
members while its unresolved members flow into the main pass.

## Hard geometry invariants

Recovery may reduce a nominal track or via only to the compiled fabrication
floor. It must not weaken clearance, hole clearance, board-edge clearance,
allowed layers or the hard track/via minimum.

Neck-down remains enabled:

```text
KICAD_IMPEDANCE_NECKDOWN=1
```

Every subprocess receives a required fab-overrides file. Ordinary `route.py`
calls omit global `--clearance`, because KRT treats it as a ceiling which can
flatten stricter net classes; the per-net project rules and fabrication floor
remain authoritative.

## Authoritative project bundle

Before every KRT subprocess, the adapter re-materializes the original compiled
`.kicad_pro`. It carries forward only the verified `protected_nets` ledger and
discards any netclass rewrite made by a previous KRT output. Missing, invalid
or uncopyable project rules are a preflight error rather than a warning with
fallback geometry.

Each invocation stores a versioned manifest containing SHA-256 hashes for the
input board, materialized project, fab overrides and optional `.kicad_dru` /
`.kicad_prl` sidecars. The manifest also records layers, rules, protected nets
and recovery switches. KRT's merged `--json-out`, compact `JSON_SUMMARY_MIN`
verdict and raw summaries remain available for forensic comparison.

## Grid policy

The configured ordinary, differential and first matched candidates stay on
KRT's native `0.1 mm` grid. Fine-pitch ordinary completion uses KRT's bounded
local rescue maps. Only a failed ordinary matched group may receive one scoped
`0.05 mm` alternative, and only when the board bounding box is at most four
million grid cells per layer. The alternative is sequential and disk-backed;
the workflow never keeps two full-copper candidates resident. An explicitly
requested QFN/QFP fanout is component-local and uses its proven `0.05 mm`
escape grid.

## QFN/QFP fanout

`qfn_fanout.py` is strictly opt-in. Package geometry alone never activates it:

```js
fanout(component("U1"), { method: "auto", extensionMm: 0.2 })
disableFanout(pad("U1", 14), pad("U1", 15))
```

`auto` first tries surface stubs, then retries only unescaped nets with the
under-pad method. `stub` and `underpad` request one method directly. Every
fanout batch uses compiled width, clearance, edge and via geometry. A failed
fanout is a warning and does not prevent native maze routing from starting on
the previous checkpoint.

## Special routing

Explicit differential-pair mapping remains authoritative through the validated
exact-selector sidecar; native name heuristics are not trusted for pairs such
as ESD-protected USB segments. Differential routing uses one configured native
candidate. An ordinary matched group also starts with one configured candidate;
only if that candidate fails its whole-group semantic gate, one
`ordering=original` alternative may run. That alternative reserves 25% of the
declared tolerance (capped at 2 mm) as internal convergence headroom, while the
independent final audit still enforces the exact DSL tolerance. This is a
two-candidate bound, not a profile portfolio. GND return-via generation is
suppressed during differential search; explicit return/plane stitching runs
against final board geometry.

`single_ended_followup_nets` are routed by one scoped native `route.py` call.
The adapter verifies that the coupled trunk was not removed and reruns the
connectivity audit before declaring the special group complete.

Disconnected special constraints are coalesced by an exact signature of KRT
rules, layer scope and length-matching mode. Incompatible representable groups
use separate subprocesses; compatible pairs/groups share one subprocess. A
group whose atomic rules cannot be represented is deferred to ordinary routing
and final special auditing instead of aborting the whole board. This avoids both
lossy global rule flattening and a process-per-net memory/time explosion.

## Native-auto workflow

The production board pipeline is:

```text
explicit local fanout (optional)
  -> compatible differential and critical matched batches
  -> full-board-verified critical ordinary batches
  -> ordinary-priority matched batches
  -> grouped high-priority / via-sensitive head start
  -> ordinary batches split by hard layer/via policy and conservative
     0.05 mm clearance / neck-down-floor buckets
  -> full-scope connectivity + DRC baseline
  -> if incomplete and all unprotected nets share one hard-policy batch:
     one disk-backed original-order monolithic candidate from the post-special
     checkpoint, using candidate-local via cost 300
  -> open-net repairs, then short avoid/forbid via repairs
      (at most 8 total attempts within 30% of ordinary-route time,
       with a 5 s startup floor for tiny boards; route and both audits share
       the same wall-clock deadline)
  -> final full-scope audit
```

The high/via-sensitive head start is editable. It is not added to the protected
ledger, so KRT may move it when native blocker recovery finds a better global
solution. `viaPreference: "avoid"` uses an isolated native search cost of 300;
`"forbid"` uses 1,000,000. Neither value changes DRC or globally overrides
KRT's via cost for unrelated nets. The same cost 300 is used by the single
monolithic completion candidate, but only after the staged route is proven
incomplete; its staged predecessor remains on disk and the candidate still must
improve connectivity while passing full-board DRC and protected-copper gates.

The monolithic fallback deliberately collapses soft priority/via-preference
partitions, because a global original-order pass can recover corridors that
early/main fragmentation loses. It never flattens incompatible allowed-layer,
clearance, or hard-width floors. Such a board skips this candidate and continues
with its valid staged partial checkpoint and bounded repairs.

`original` means the order of `netclass_assignments` in the authoritative
generated KiCad project, not the canonical lexicographic order of the in-memory
board model. The exact-selector sidecar preserves this project order. In
particular, a distinct power-width class normally remains after the ordinary
signal class instead of being pulled to the front merely because its names
start with `+`; changing this order can change KRT's rip-up result.

Nearby per-net clearances and hard neck-down widths are rounded upward into
0.05 mm orchestration buckets. Each width bucket uses its strictest hard floor;
ordinary nominal widths still come from KRT's authoritative per-net netclasses.
The buckets bound process and full-board-audit growth when a generated design
contains hundreds of slightly different values. Preferred via
geometry is a nominal CLI value, while actual minimum diameter/drill/annular
rules remain separate fabrication floors so native terminal escalation is not
accidentally disabled.

Critical, early and main ordinary stages share a hard budget of 32 native
compatibility batches per backend invocation. Priority ordering spends that
budget on critical/high nets first; any incompatible overflow remains explicit
in the final open-net audit and the result stays applicable as `partial`. This
bounds adversarial thousand-net DSLs with hundreds of distinct allowed-layer
sets instead of launching one process per compatibility signature. Complete
subprocess stdout/stderr is streamed to the artifact directory while only a
512 KiB tail of each stream remains resident in the workflow result.

Every promoted route batch has at most two full-board audit subprocesses
(connectivity and DRC). Critical routing reuses this outer evidence rather than
running a duplicate inner audit set. Thus the adversarial 32-batch ceiling is
also an explicit 64 stage-gate-audit ceiling; typical uniform thousand-net
boards coalesce to one to three route batches.

Every DSL net name crosses KRT through a disk-backed exact-selector allowlist
and collision-free opaque CLI tokens; whole-scope selectors collapse to one
constant-size sentinel. Sentinels are moved automatically if a real net uses a
reserved spelling. Explicit P/N mappings use that same sidecar,
and the complete native tool argv is stored in a separate JSON file. Only a
fixed Python bootstrap and two file paths cross Windows `CreateProcess`. The
same exact context follows raw names used by KRT's internal recovery filters
after pattern expansion. Thus `DATA[0]`,
active-low `!RESET[0]`, `SIG` and the distinct hierarchical `/Sheet/SIG` cannot
alias each other. Connectivity and DRC verdicts are written to JSON sidecars
(not a bounded stdout tail) and fail closed unless the native parser resolves
exactly the whole requested scope. Argv and environment size therefore remain
bounded even for thousand-net scopes on Windows.

Post-main open-net repairs are grouped by compatible layer/via policy. A
connected `avoid`/`forbid` net no longer disappears from consideration merely
because it is electrically complete: when it is at most 10 mm long and still
contains vias, KRT may force-reroute that one net. Open and connected-via jobs
share the same limit of eight processes and the same wall-clock deadline,
including connectivity and DRC audits.

An open-net repair may grant KRT at most three observed lower-priority blockers
as explicit rip victims. Verified special/critical copper, GND and zone-owned
nets are never eligible. The candidate must restore every victim and pass the
same full-board checkpoint gate, so blocker knowledge improves search without
turning priority into destructive global locking.

A repair artifact is applied only if it does not reopen any previously
connected net, does not increase scoped native DRC and does not report protected
copper damage or an unrecovered rip victim. An open-net job must improve
connectivity or DRC; a connected-net job must strictly reduce that net's via
count. Rejected attempts remain on disk for forensics and do not erase the
preceding partial checkpoint.

Stage hard-rule gates compare only copper added or changed since the promoted
checkpoint. An unchanged pre-existing narrow track or legacy via is still
reported by the final absolute audit, but cannot deadlock all otherwise useful
partial routing progress.

A critical ordinary target is temporarily removed from the native protected
ledger only for its own isolated force-reroute. Every other protected net stays
locked. The improved target is accepted only after the same full-board gates
pass and its protection entry has been restored; otherwise the pre-repair
protected checkpoint remains current.

## Partial-result contract

An open net, failed length/skew target, timeout with a readable PCB, excessive
via count or ordinary DRC diagnostic produces a gradable partial candidate.
Transport status does not erase parseable copper. A later stage cannot erase
the last structurally applicable checkpoint.

Catastrophic geometry, an unreadable output, protected-net damage or an
unrecovered rip victim rejects only that candidate. If an earlier safe
checkpoint exists, the router returns it as `partial`; terminal `error` is
reserved for the absence of any safely applicable result.

## Deferred

- native track/pad teardrops;
- incompatible per-net via geometry or layer groups in one KRT process;
- enforcement of `maxUncoupledLengthMm`;
- time matching and AC-coupling matching;
- native coplanar/impedance controls beyond compiled width/gap;
- layer-swap and proximity-guide candidate portfolios.

Each new upstream option requires an exact semantic mapping, hard-rule audit,
partial-safe checkpoint and multi-board regression before becoming production
policy.
