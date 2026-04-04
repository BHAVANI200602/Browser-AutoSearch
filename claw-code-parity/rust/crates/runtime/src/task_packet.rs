use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoConfig {
    pub repo_root: PathBuf,
    pub worktree_root: Option<PathBuf>,
}

impl RepoConfig {
    #[must_use]
    pub fn dispatch_root(&self) -> &Path {
        self.worktree_root
            .as_deref()
            .unwrap_or(self.repo_root.as_path())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskScope {
    SingleFile { path: PathBuf },
    Module { crate_name: String },
    Workspace,
    Custom { paths: Vec<PathBuf> },
}

impl TaskScope {
    #[must_use]
    pub fn resolve_paths(&self, repo_config: &RepoConfig) -> Vec<PathBuf> {
        let dispatch_root = repo_config.dispatch_root();
        match self {
            Self::SingleFile { path } => vec![resolve_path(dispatch_root, path)],
            Self::Module { crate_name } => vec![dispatch_root.join("crates").join(crate_name)],
            Self::Workspace => vec![dispatch_root.to_path_buf()],
            Self::Custom { paths } => paths
                .iter()
                .map(|path| resolve_path(dispatch_root, path))
                .collect(),
        }
    }
}

impl Display for TaskScope {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SingleFile { .. } => write!(f, "single_file"),
            Self::Module { .. } => write!(f, "module"),
            Self::Workspace => write!(f, "workspace"),
            Self::Custom { .. } => write!(f, "custom"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchPolicy {
    CreateNew { prefix: String },
    UseExisting { name: String },
    WorktreeIsolated,
}

impl Display for BranchPolicy {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CreateNew { .. } => write!(f, "create_new"),
            Self::UseExisting { .. } => write!(f, "use_existing"),
            Self::WorktreeIsolated => write!(f, "worktree_isolated"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitPolicy {
    CommitPerTask,
    SquashOnMerge,
    NoAutoCommit,
}

impl Display for CommitPolicy {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CommitPerTask => write!(f, "commit_per_task"),
            Self::SquashOnMerge => write!(f, "squash_on_merge"),
            Self::NoAutoCommit => write!(f, "no_auto_commit"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GreenLevel {
    Package,
    Workspace,
    MergeReady,
}

impl Display for GreenLevel {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Package => write!(f, "package"),
            Self::Workspace => write!(f, "workspace"),
            Self::MergeReady => write!(f, "merge_ready"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceTest {
    CargoTest { filter: Option<String> },
    CustomCommand { cmd: String },
    GreenLevel { level: GreenLevel },
}

impl Display for AcceptanceTest {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CargoTest { .. } => write!(f, "cargo_test"),
            Self::CustomCommand { .. } => write!(f, "custom_command"),
            Self::GreenLevel { .. } => write!(f, "green_level"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportingContract {
    EventStream,
    Summary,
    Silent,
}

impl Display for ReportingContract {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EventStream => write!(f, "event_stream"),
            Self::Summary => write!(f, "summary"),
            Self::Silent => write!(f, "silent"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscalationPolicy {
    RetryThenEscalate { max_retries: u32 },
    AutoEscalate,
    NeverEscalate,
}

impl Display for EscalationPolicy {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RetryThenEscalate { .. } => write!(f, "retry_then_escalate"),
            Self::AutoEscalate => write!(f, "auto_escalate"),
            Self::NeverEscalate => write!(f, "never_escalate"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskPacket {
    pub id: String,
    pub objective: String,
    pub scope: TaskScope,
    pub repo_config: RepoConfig,
    pub branch_policy: BranchPolicy,
    pub acceptance_tests: Vec<AcceptanceTest>,
    pub commit_policy: CommitPolicy,
    pub reporting: ReportingContract,
    pub escalation: EscalationPolicy,
    pub created_at: u64,
    pub metadata: BTreeMap<String, JsonValue>,
}

impl TaskPacket {
    #[must_use]
    pub fn resolve_scope_paths(&self) -> Vec<PathBuf> {
        self.scope.resolve_paths(&self.repo_config)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPacketValidationError {
    errors: Vec<String>,
}

impl TaskPacketValidationError {
    #[must_use]
    pub fn new(errors: Vec<String>) -> Self {
        Self { errors }
    }

    #[must_use]
    pub fn errors(&self) -> &[String] {
        &self.errors
    }
}

impl Display for TaskPacketValidationError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.errors.join("; "))
    }
}

impl std::error::Error for TaskPacketValidationError {}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedPacket(TaskPacket);

impl ValidatedPacket {
    #[must_use]
    pub fn packet(&self) -> &TaskPacket {
        &self.0
    }

    #[must_use]
    pub fn into_inner(self) -> TaskPacket {
        self.0
    }

    #[must_use]
    pub fn resolve_scope_paths(&self) -> Vec<PathBuf> {
        self.0.resolve_scope_paths()
    }
}

pub fn validate_packet(packet: TaskPacket) -> Result<ValidatedPacket, TaskPacketValidationError> {
    let mut errors = Vec::new();

    if packet.id.trim().is_empty() {
        errors.push("packet id must not be empty".to_string());
    }

    if packet.objective.trim().is_empty() {
        errors.push("packet objective must not be empty".to_string());
    }

    if packet.repo_config.repo_root.as_os_str().is_empty() {
        errors.push("repo_config repo_root must not be empty".to_string());
    }

    if packet
        .repo_config
        .worktree_root
        .as_ref()
        .is_some_and(|path| path.as_os_str().is_empty())
    {
        errors.push("repo_config worktree_root must not be empty when present".to_string());
    }

    validate_scope(&packet.scope, &mut errors);
    validate_branch_policy(&packet.branch_policy, &mut errors);
    validate_acceptance_tests(&packet.acceptance_tests, &mut errors);
    validate_escalation_policy(packet.escalation, &mut errors);

    if errors.is_empty() {
        Ok(ValidatedPacket(packet))
    } else {
        Err(TaskPacketValidationError::new(errors))
    }
}

fn validate_scope(scope: &TaskScope, errors: &mut Vec<String>) {
    match scope {
        TaskScope::SingleFile { path } if path.as_os_str().is_empty() => {
            errors.push("single_file scope path must not be empty".to_string());
        }
        TaskScope::Module { crate_name } if crate_name.trim().is_empty() => {
            errors.push("module scope crate_name must not be empty".to_string());
        }
        TaskScope::Custom { paths } if paths.is_empty() => {
            errors.push("custom scope paths must not be empty".to_string());
        }
        TaskScope::Custom { paths } => {
            for (index, path) in paths.iter().enumerate() {
                if path.as_os_str().is_empty() {
                    errors.push(format!("custom scope contains empty path at index {index}"));
                }
            }
        }
        TaskScope::SingleFile { .. } | TaskScope::Module { .. } | TaskScope::Workspace => {}
    }
}

fn validate_branch_policy(branch_policy: &BranchPolicy, errors: &mut Vec<String>) {
    match branch_policy {
        BranchPolicy::CreateNew { prefix } if prefix.trim().is_empty() => {
            errors.push("create_new branch prefix must not be empty".to_string());
        }
        BranchPolicy::UseExisting { name } if name.trim().is_empty() => {
            errors.push("use_existing branch name must not be empty".to_string());
        }
        BranchPolicy::CreateNew { .. }
        | BranchPolicy::UseExisting { .. }
        | BranchPolicy::WorktreeIsolated => {}
    }
}

fn validate_acceptance_tests(tests: &[AcceptanceTest], errors: &mut Vec<String>) {
    for test in tests {
        match test {
            AcceptanceTest::CargoTest { filter } => {
                if filter
                    .as_deref()
                    .is_some_and(|value| value.trim().is_empty())
                {
                    errors.push("cargo_test filter must not be empty when present".to_string());
                }
            }
            AcceptanceTest::CustomCommand { cmd } if cmd.trim().is_empty() => {
                errors.push("custom_command cmd must not be empty".to_string());
            }
            AcceptanceTest::CustomCommand { .. } | AcceptanceTest::GreenLevel { .. } => {}
        }
    }
}

fn validate_escalation_policy(escalation: EscalationPolicy, errors: &mut Vec<String>) {
    if matches!(
        escalation,
        EscalationPolicy::RetryThenEscalate { max_retries: 0 }
    ) {
        errors.push("retry_then_escalate max_retries must be greater than zero".to_string());
    }
}

fn resolve_path(dispatch_root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        dispatch_root.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn sample_repo_config() -> RepoConfig {
        RepoConfig {
            repo_root: PathBuf::from("/repo"),
            worktree_root: Some(PathBuf::from("/repo/.worktrees/task-1")),
        }
    }

    fn sample_packet() -> TaskPacket {
        let mut metadata = BTreeMap::new();
        metadata.insert("attempt".to_string(), json!(1));
        metadata.insert("lane".to_string(), json!("runtime"));

        TaskPacket {
            id: "packet_001".to_string(),
            objective: "Implement typed task packet format".to_string(),
            scope: TaskScope::Module {
                crate_name: "runtime".to_string(),
            },
            repo_config: sample_repo_config(),
            branch_policy: BranchPolicy::CreateNew {
                prefix: "ultraclaw".to_string(),
            },
            acceptance_tests: vec![
                AcceptanceTest::CargoTest {
                    filter: Some("task_packet".to_string()),
                },
                AcceptanceTest::GreenLevel {
                    level: GreenLevel::Workspace,
                },
            ],
            commit_policy: CommitPolicy::CommitPerTask,
            reporting: ReportingContract::EventStream,
            escalation: EscalationPolicy::RetryThenEscalate { max_retries: 2 },
            created_at: now_secs(),
            metadata,
        }
    }

    #[test]
    fn valid_packet_passes_validation() {
        // given
        let packet = sample_packet();

        // when
        let validated = validate_packet(packet);

        // then
        assert!(validated.is_ok());
    }

    #[test]
    fn invalid_packet_accumulates_errors() {
        // given
        let packet = TaskPacket {
            id: " ".to_string(),
            objective: " ".to_string(),
            scope: TaskScope::Custom {
                paths: vec![PathBuf::new()],
            },
            repo_config: RepoConfig {
                repo_root: PathBuf::new(),
                worktree_root: Some(PathBuf::new()),
            },
            branch_policy: BranchPolicy::CreateNew {
                prefix: " ".to_string(),
            },
            acceptance_tests: vec![
                AcceptanceTest::CargoTest {
                    filter: Some(" ".to_string()),
                },
                AcceptanceTest::CustomCommand {
                    cmd: " ".to_string(),
                },
            ],
            commit_policy: CommitPolicy::NoAutoCommit,
            reporting: ReportingContract::Silent,
            escalation: EscalationPolicy::RetryThenEscalate { max_retries: 0 },
            created_at: 0,
            metadata: BTreeMap::new(),
        };

        // when
        let error = validate_packet(packet).expect_err("packet should be rejected");

        // then
        assert!(error.errors().len() >= 8);
        assert!(error
            .errors()
            .contains(&"packet id must not be empty".to_string()));
        assert!(error
            .errors()
            .contains(&"packet objective must not be empty".to_string()));
        assert!(error
            .errors()
            .contains(&"repo_config repo_root must not be empty".to_string()));
        assert!(error
            .errors()
            .contains(&"create_new branch prefix must not be empty".to_string()));
    }

    #[test]
    fn single_file_scope_resolves_against_worktree_root() {
        // given
        let repo_config = sample_repo_config();
        let scope = TaskScope::SingleFile {
            path: PathBuf::from("crates/runtime/src/task_packet.rs"),
        };

        // when
        let paths = scope.resolve_paths(&repo_config);

        // then
        assert_eq!(
            paths,
            vec![PathBuf::from(
                "/repo/.worktrees/task-1/crates/runtime/src/task_packet.rs"
            )]
        );
    }

    #[test]
    fn workspace_scope_resolves_to_dispatch_root() {
        // given
        let repo_config = sample_repo_config();
        let scope = TaskScope::Workspace;

        // when
        let paths = scope.resolve_paths(&repo_config);

        // then
        assert_eq!(paths, vec![PathBuf::from("/repo/.worktrees/task-1")]);
    }

    #[test]
    fn module_scope_resolves_to_crate_directory() {
        // given
        let repo_config = sample_repo_config();
        let scope = TaskScope::Module {
            crate_name: "runtime".to_string(),
        };

        // when
        let paths = scope.resolve_paths(&repo_config);

        // then
        assert_eq!(
            paths,
            vec![PathBuf::from("/repo/.worktrees/task-1/crates/runtime")]
        );
    }

    #[test]
    fn custom_scope_preserves_absolute_paths_and_resolves_relative_paths() {
        // given
        let repo_config = sample_repo_config();
        let scope = TaskScope::Custom {
            paths: vec![
                PathBuf::from("Cargo.toml"),
                PathBuf::from("/tmp/shared/script.sh"),
            ],
        };

        // when
        let paths = scope.resolve_paths(&repo_config);

        // then
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/repo/.worktrees/task-1/Cargo.toml"),
                PathBuf::from("/tmp/shared/script.sh"),
            ]
        );
    }

    #[test]
    fn serialization_roundtrip_preserves_packet() {
        // given
        let packet = sample_packet();

        // when
        let serialized = serde_json::to_string(&packet).expect("packet should serialize");
        let deserialized: TaskPacket =
            serde_json::from_str(&serialized).expect("packet should deserialize");

        // then
        assert_eq!(deserialized, packet);
    }

    #[test]
    fn validated_packet_exposes_inner_packet_and_scope_paths() {
        // given
        let packet = sample_packet();

        // when
        let validated = validate_packet(packet.clone()).expect("packet should validate");
        let resolved_paths = validated.resolve_scope_paths();
        let inner = validated.into_inner();

        // then
        assert_eq!(
            resolved_paths,
            vec![PathBuf::from("/repo/.worktrees/task-1/crates/runtime")]
        );
        assert_eq!(inner, packet);
    }

    #[test]
    fn display_impls_render_snake_case_variants() {
        // given
        let rendered = vec![
            TaskScope::Workspace.to_string(),
            BranchPolicy::WorktreeIsolated.to_string(),
            CommitPolicy::SquashOnMerge.to_string(),
            GreenLevel::MergeReady.to_string(),
            AcceptanceTest::GreenLevel {
                level: GreenLevel::Package,
            }
            .to_string(),
            ReportingContract::EventStream.to_string(),
            EscalationPolicy::AutoEscalate.to_string(),
        ];

        // when
        let expected = vec![
            "workspace",
            "worktree_isolated",
            "squash_on_merge",
            "merge_ready",
            "green_level",
            "event_stream",
            "auto_escalate",
        ];

        // then
        assert_eq!(rendered, expected);
    }
}
