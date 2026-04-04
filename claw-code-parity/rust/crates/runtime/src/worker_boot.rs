//! In-memory worker-boot state machine and control registry.
//!
//! This provides a foundational control plane for reliable worker startup:
//! trust-gate detection, ready-for-prompt handshakes, and prompt-misdelivery
//! detection/recovery all live above raw terminal transport.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Spawning,
    TrustRequired,
    ReadyForPrompt,
    PromptAccepted,
    Running,
    Blocked,
    Finished,
    Failed,
}

impl std::fmt::Display for WorkerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawning => write!(f, "spawning"),
            Self::TrustRequired => write!(f, "trust_required"),
            Self::ReadyForPrompt => write!(f, "ready_for_prompt"),
            Self::PromptAccepted => write!(f, "prompt_accepted"),
            Self::Running => write!(f, "running"),
            Self::Blocked => write!(f, "blocked"),
            Self::Finished => write!(f, "finished"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerFailureKind {
    TrustGate,
    PromptDelivery,
    Protocol,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerFailure {
    pub kind: WorkerFailureKind,
    pub message: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerEventKind {
    Spawning,
    TrustRequired,
    TrustResolved,
    ReadyForPrompt,
    PromptAccepted,
    PromptMisdelivery,
    PromptReplayArmed,
    Running,
    Restarted,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerEvent {
    pub seq: u64,
    pub kind: WorkerEventKind,
    pub status: WorkerStatus,
    pub detail: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Worker {
    pub worker_id: String,
    pub cwd: String,
    pub status: WorkerStatus,
    pub trust_auto_resolve: bool,
    pub trust_gate_cleared: bool,
    pub auto_recover_prompt_misdelivery: bool,
    pub prompt_delivery_attempts: u32,
    pub last_prompt: Option<String>,
    pub replay_prompt: Option<String>,
    pub last_error: Option<WorkerFailure>,
    pub created_at: u64,
    pub updated_at: u64,
    pub events: Vec<WorkerEvent>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerRegistry {
    inner: Arc<Mutex<WorkerRegistryInner>>,
}

#[derive(Debug, Default)]
struct WorkerRegistryInner {
    workers: HashMap<String, Worker>,
    counter: u64,
}

impl WorkerRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn create(
        &self,
        cwd: &str,
        trusted_roots: &[String],
        auto_recover_prompt_misdelivery: bool,
    ) -> Worker {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        inner.counter += 1;
        let ts = now_secs();
        let worker_id = format!("worker_{:08x}_{}", ts, inner.counter);
        let trust_auto_resolve = trusted_roots
            .iter()
            .any(|root| path_matches_allowlist(cwd, root));
        let mut worker = Worker {
            worker_id: worker_id.clone(),
            cwd: cwd.to_owned(),
            status: WorkerStatus::Spawning,
            trust_auto_resolve,
            trust_gate_cleared: false,
            auto_recover_prompt_misdelivery,
            prompt_delivery_attempts: 0,
            last_prompt: None,
            replay_prompt: None,
            last_error: None,
            created_at: ts,
            updated_at: ts,
            events: Vec::new(),
        };
        push_event(
            &mut worker,
            WorkerEventKind::Spawning,
            WorkerStatus::Spawning,
            Some("worker created".to_string()),
        );
        inner.workers.insert(worker_id, worker.clone());
        worker
    }

    #[must_use]
    pub fn get(&self, worker_id: &str) -> Option<Worker> {
        let inner = self.inner.lock().expect("worker registry lock poisoned");
        inner.workers.get(worker_id).cloned()
    }

    pub fn observe(&self, worker_id: &str, screen_text: &str) -> Result<Worker, String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;
        let lowered = screen_text.to_ascii_lowercase();

        if !worker.trust_gate_cleared && detect_trust_prompt(&lowered) {
            worker.status = WorkerStatus::TrustRequired;
            worker.last_error = Some(WorkerFailure {
                kind: WorkerFailureKind::TrustGate,
                message: "worker boot blocked on trust prompt".to_string(),
                created_at: now_secs(),
            });
            push_event(
                worker,
                WorkerEventKind::TrustRequired,
                WorkerStatus::TrustRequired,
                Some("trust prompt detected".to_string()),
            );

            if worker.trust_auto_resolve {
                worker.trust_gate_cleared = true;
                worker.last_error = None;
                worker.status = WorkerStatus::Spawning;
                push_event(
                    worker,
                    WorkerEventKind::TrustResolved,
                    WorkerStatus::Spawning,
                    Some("allowlisted repo auto-resolved trust prompt".to_string()),
                );
            } else {
                return Ok(worker.clone());
            }
        }

        if prompt_misdelivery_is_relevant(worker)
            && detect_prompt_misdelivery(&lowered, worker.last_prompt.as_deref())
        {
            let detail = prompt_preview(worker.last_prompt.as_deref().unwrap_or_default());
            worker.last_error = Some(WorkerFailure {
                kind: WorkerFailureKind::PromptDelivery,
                message: format!("worker prompt landed in shell instead of coding agent: {detail}"),
                created_at: now_secs(),
            });
            push_event(
                worker,
                WorkerEventKind::PromptMisdelivery,
                WorkerStatus::Blocked,
                Some("shell misdelivery detected".to_string()),
            );
            if worker.auto_recover_prompt_misdelivery {
                worker.replay_prompt = worker.last_prompt.clone();
                worker.status = WorkerStatus::ReadyForPrompt;
                push_event(
                    worker,
                    WorkerEventKind::PromptReplayArmed,
                    WorkerStatus::ReadyForPrompt,
                    Some("prompt replay armed after shell misdelivery".to_string()),
                );
            } else {
                worker.status = WorkerStatus::Blocked;
            }
            return Ok(worker.clone());
        }

        if detect_running_cue(&lowered)
            && matches!(
                worker.status,
                WorkerStatus::PromptAccepted | WorkerStatus::ReadyForPrompt
            )
        {
            worker.status = WorkerStatus::Running;
            worker.last_error = None;
            push_event(
                worker,
                WorkerEventKind::Running,
                WorkerStatus::Running,
                Some("worker accepted prompt and started running".to_string()),
            );
        }

        if detect_ready_for_prompt(screen_text, &lowered)
            && !matches!(
                worker.status,
                WorkerStatus::ReadyForPrompt | WorkerStatus::Running
            )
        {
            worker.status = WorkerStatus::ReadyForPrompt;
            if matches!(
                worker.last_error.as_ref().map(|failure| failure.kind),
                Some(WorkerFailureKind::TrustGate)
            ) {
                worker.last_error = None;
            }
            push_event(
                worker,
                WorkerEventKind::ReadyForPrompt,
                WorkerStatus::ReadyForPrompt,
                Some("worker is ready for prompt delivery".to_string()),
            );
        }

        Ok(worker.clone())
    }

    pub fn resolve_trust(&self, worker_id: &str) -> Result<Worker, String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;

        if worker.status != WorkerStatus::TrustRequired {
            return Err(format!(
                "worker {worker_id} is not waiting on trust; current status: {}",
                worker.status
            ));
        }

        worker.trust_gate_cleared = true;
        worker.last_error = None;
        worker.status = WorkerStatus::Spawning;
        push_event(
            worker,
            WorkerEventKind::TrustResolved,
            WorkerStatus::Spawning,
            Some("trust prompt resolved manually".to_string()),
        );
        Ok(worker.clone())
    }

    pub fn send_prompt(&self, worker_id: &str, prompt: Option<&str>) -> Result<Worker, String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;

        if worker.status != WorkerStatus::ReadyForPrompt {
            return Err(format!(
                "worker {worker_id} is not ready for prompt delivery; current status: {}",
                worker.status
            ));
        }

        let next_prompt = prompt
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| worker.replay_prompt.clone())
            .ok_or_else(|| format!("worker {worker_id} has no prompt to send or replay"))?;

        worker.prompt_delivery_attempts += 1;
        worker.last_prompt = Some(next_prompt.clone());
        worker.replay_prompt = None;
        worker.last_error = None;
        worker.status = WorkerStatus::PromptAccepted;
        push_event(
            worker,
            WorkerEventKind::PromptAccepted,
            WorkerStatus::PromptAccepted,
            Some(format!(
                "prompt accepted for delivery: {}",
                prompt_preview(&next_prompt)
            )),
        );
        Ok(worker.clone())
    }

    pub fn await_ready(&self, worker_id: &str) -> Result<WorkerReadySnapshot, String> {
        let worker = self
            .get(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;

        Ok(WorkerReadySnapshot {
            worker_id: worker.worker_id.clone(),
            status: worker.status,
            ready: worker.status == WorkerStatus::ReadyForPrompt,
            blocked: matches!(
                worker.status,
                WorkerStatus::TrustRequired | WorkerStatus::Blocked
            ),
            replay_prompt_ready: worker.replay_prompt.is_some(),
            last_error: worker.last_error.clone(),
        })
    }

    pub fn restart(&self, worker_id: &str) -> Result<Worker, String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;
        worker.status = WorkerStatus::Spawning;
        worker.trust_gate_cleared = false;
        worker.last_prompt = None;
        worker.replay_prompt = None;
        worker.last_error = None;
        worker.prompt_delivery_attempts = 0;
        push_event(
            worker,
            WorkerEventKind::Restarted,
            WorkerStatus::Spawning,
            Some("worker restarted".to_string()),
        );
        Ok(worker.clone())
    }

    pub fn terminate(&self, worker_id: &str) -> Result<Worker, String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(worker_id)
            .ok_or_else(|| format!("worker not found: {worker_id}"))?;
        worker.status = WorkerStatus::Finished;
        push_event(
            worker,
            WorkerEventKind::Finished,
            WorkerStatus::Finished,
            Some("worker terminated by control plane".to_string()),
        );
        Ok(worker.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerReadySnapshot {
    pub worker_id: String,
    pub status: WorkerStatus,
    pub ready: bool,
    pub blocked: bool,
    pub replay_prompt_ready: bool,
    pub last_error: Option<WorkerFailure>,
}

fn prompt_misdelivery_is_relevant(worker: &Worker) -> bool {
    matches!(
        worker.status,
        WorkerStatus::PromptAccepted | WorkerStatus::Running
    ) && worker.last_prompt.is_some()
}

fn push_event(
    worker: &mut Worker,
    kind: WorkerEventKind,
    status: WorkerStatus,
    detail: Option<String>,
) {
    let timestamp = now_secs();
    let seq = worker.events.len() as u64 + 1;
    worker.updated_at = timestamp;
    worker.events.push(WorkerEvent {
        seq,
        kind,
        status,
        detail,
        timestamp,
    });
}

fn path_matches_allowlist(cwd: &str, trusted_root: &str) -> bool {
    let cwd = normalize_path(cwd);
    let trusted_root = normalize_path(trusted_root);
    cwd == trusted_root || cwd.starts_with(&trusted_root)
}

fn normalize_path(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf())
}

fn detect_trust_prompt(lowered: &str) -> bool {
    [
        "do you trust the files in this folder",
        "trust the files in this folder",
        "trust this folder",
        "allow and continue",
        "yes, proceed",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn detect_ready_for_prompt(screen_text: &str, lowered: &str) -> bool {
    if [
        "ready for input",
        "ready for your input",
        "ready for prompt",
        "send a message",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        return true;
    }

    let Some(last_non_empty) = screen_text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
    else {
        return false;
    };
    let trimmed = last_non_empty.trim();
    if is_shell_prompt(trimmed) {
        return false;
    }

    trimmed == ">"
        || trimmed == "›"
        || trimmed == "❯"
        || trimmed.starts_with("> ")
        || trimmed.starts_with("› ")
        || trimmed.starts_with("❯ ")
        || trimmed.contains("│ >")
        || trimmed.contains("│ ›")
        || trimmed.contains("│ ❯")
}

fn detect_running_cue(lowered: &str) -> bool {
    [
        "thinking",
        "working",
        "running tests",
        "inspecting",
        "analyzing",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn is_shell_prompt(trimmed: &str) -> bool {
    trimmed.ends_with('$')
        || trimmed.ends_with('%')
        || trimmed.ends_with('#')
        || trimmed.starts_with('$')
        || trimmed.starts_with('%')
        || trimmed.starts_with('#')
}

fn detect_prompt_misdelivery(lowered: &str, prompt: Option<&str>) -> bool {
    let Some(prompt) = prompt else {
        return false;
    };

    let shell_error = [
        "command not found",
        "syntax error near unexpected token",
        "parse error near",
        "no such file or directory",
        "unknown command",
    ]
    .iter()
    .any(|needle| lowered.contains(needle));

    if !shell_error {
        return false;
    }

    let first_prompt_line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_ascii_lowercase())
        .unwrap_or_default();

    first_prompt_line.is_empty() || lowered.contains(&first_prompt_line)
}

fn prompt_preview(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.chars().count() <= 48 {
        return trimmed.to_string();
    }
    let preview = trimmed.chars().take(48).collect::<String>();
    format!("{}…", preview.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlisted_trust_prompt_auto_resolves_then_reaches_ready_state() {
        let registry = WorkerRegistry::new();
        let worker = registry.create(
            "/tmp/worktrees/repo-a",
            &["/tmp/worktrees".to_string()],
            true,
        );

        let after_trust = registry
            .observe(
                &worker.worker_id,
                "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
            )
            .expect("trust observe should succeed");
        assert_eq!(after_trust.status, WorkerStatus::Spawning);
        assert!(after_trust.trust_gate_cleared);
        assert!(after_trust
            .events
            .iter()
            .any(|event| event.kind == WorkerEventKind::TrustRequired));
        assert!(after_trust
            .events
            .iter()
            .any(|event| event.kind == WorkerEventKind::TrustResolved));

        let ready = registry
            .observe(&worker.worker_id, "Ready for your input\n>")
            .expect("ready observe should succeed");
        assert_eq!(ready.status, WorkerStatus::ReadyForPrompt);
        assert!(ready.last_error.is_none());
    }

    #[test]
    fn trust_prompt_blocks_non_allowlisted_worker_until_resolved() {
        let registry = WorkerRegistry::new();
        let worker = registry.create("/tmp/repo-b", &[], true);

        let blocked = registry
            .observe(
                &worker.worker_id,
                "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
            )
            .expect("trust observe should succeed");
        assert_eq!(blocked.status, WorkerStatus::TrustRequired);
        assert_eq!(
            blocked.last_error.expect("trust error should exist").kind,
            WorkerFailureKind::TrustGate
        );

        let send_before_resolve = registry.send_prompt(&worker.worker_id, Some("ship it"));
        assert!(send_before_resolve
            .expect_err("prompt delivery should be gated")
            .contains("not ready for prompt delivery"));

        let resolved = registry
            .resolve_trust(&worker.worker_id)
            .expect("manual trust resolution should succeed");
        assert_eq!(resolved.status, WorkerStatus::Spawning);
        assert!(resolved.trust_gate_cleared);
    }

    #[test]
    fn ready_detection_ignores_plain_shell_prompts() {
        assert!(!detect_ready_for_prompt("bellman@host %", "bellman@host %"));
        assert!(!detect_ready_for_prompt("/tmp/repo $", "/tmp/repo $"));
        assert!(detect_ready_for_prompt("│ >", "│ >"));
    }

    #[test]
    fn prompt_misdelivery_is_detected_and_replay_can_be_rearmed() {
        let registry = WorkerRegistry::new();
        let worker = registry.create("/tmp/repo-c", &[], true);
        registry
            .observe(&worker.worker_id, "Ready for input\n>")
            .expect("ready observe should succeed");

        let accepted = registry
            .send_prompt(&worker.worker_id, Some("Implement worker handshake"))
            .expect("prompt send should succeed");
        assert_eq!(accepted.status, WorkerStatus::PromptAccepted);
        assert_eq!(accepted.prompt_delivery_attempts, 1);

        let recovered = registry
            .observe(
                &worker.worker_id,
                "% Implement worker handshake\nzsh: command not found: Implement",
            )
            .expect("misdelivery observe should succeed");
        assert_eq!(recovered.status, WorkerStatus::ReadyForPrompt);
        assert_eq!(
            recovered
                .last_error
                .expect("misdelivery error should exist")
                .kind,
            WorkerFailureKind::PromptDelivery
        );
        assert_eq!(
            recovered.replay_prompt.as_deref(),
            Some("Implement worker handshake")
        );
        assert!(recovered
            .events
            .iter()
            .any(|event| event.kind == WorkerEventKind::PromptMisdelivery));
        assert!(recovered
            .events
            .iter()
            .any(|event| event.kind == WorkerEventKind::PromptReplayArmed));

        let replayed = registry
            .send_prompt(&worker.worker_id, None)
            .expect("replay send should succeed");
        assert_eq!(replayed.status, WorkerStatus::PromptAccepted);
        assert!(replayed.replay_prompt.is_none());
        assert_eq!(replayed.prompt_delivery_attempts, 2);
    }

    #[test]
    fn await_ready_surfaces_blocked_or_ready_worker_state() {
        let registry = WorkerRegistry::new();
        let worker = registry.create("/tmp/repo-d", &[], false);

        let initial = registry
            .await_ready(&worker.worker_id)
            .expect("await should succeed");
        assert!(!initial.ready);
        assert!(!initial.blocked);

        registry
            .observe(
                &worker.worker_id,
                "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
            )
            .expect("trust observe should succeed");
        let blocked = registry
            .await_ready(&worker.worker_id)
            .expect("await should succeed");
        assert!(!blocked.ready);
        assert!(blocked.blocked);

        registry
            .resolve_trust(&worker.worker_id)
            .expect("manual trust resolution should succeed");
        registry
            .observe(&worker.worker_id, "Ready for your input\n>")
            .expect("ready observe should succeed");
        let ready = registry
            .await_ready(&worker.worker_id)
            .expect("await should succeed");
        assert!(ready.ready);
        assert!(!ready.blocked);
        assert!(ready.last_error.is_none());
    }

    #[test]
    fn restart_and_terminate_reset_or_finish_worker() {
        let registry = WorkerRegistry::new();
        let worker = registry.create("/tmp/repo-e", &[], true);
        registry
            .observe(&worker.worker_id, "Ready for input\n>")
            .expect("ready observe should succeed");
        registry
            .send_prompt(&worker.worker_id, Some("Run tests"))
            .expect("prompt send should succeed");

        let restarted = registry
            .restart(&worker.worker_id)
            .expect("restart should succeed");
        assert_eq!(restarted.status, WorkerStatus::Spawning);
        assert_eq!(restarted.prompt_delivery_attempts, 0);
        assert!(restarted.last_prompt.is_none());

        let finished = registry
            .terminate(&worker.worker_id)
            .expect("terminate should succeed");
        assert_eq!(finished.status, WorkerStatus::Finished);
        assert!(finished
            .events
            .iter()
            .any(|event| event.kind == WorkerEventKind::Finished));
    }
}
