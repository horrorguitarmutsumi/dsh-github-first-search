//! Canonical JSON shapes printed to stdout — the contract with the JS shell
//! (`../src/engine.ts`). Changing a field here is a breaking change for the shell.

use serde::Serialize;

/// One repository row of a search result.
#[derive(Debug, Serialize)]
pub struct RepoHit {
    pub full_name: String,
    pub html_url: String,
    #[serde(default)]
    pub description: String,
    pub stars: u64,
    #[serde(default)]
    pub forks: u64,
    pub language: Option<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub open_issues: u64,
}

/// Output of `github-first search`.
#[derive(Debug, Serialize)]
pub struct SearchOutput {
    /// The final query actually sent to GitHub, qualifiers included.
    pub query: String,
    pub total_count: u64,
    pub results: Vec<RepoHit>,
}

/// Output of `github-first readme`.
#[derive(Debug, Serialize)]
pub struct ReadmeOutput {
    pub repo: String,
    pub path: String,
    pub html_url: String,
    pub content: String,
    pub truncated: bool,
}

/// Error document printed on failure: `{"error": {"kind": …, "message": …}}`.
#[derive(Debug, Serialize)]
pub struct ErrorOutput {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub kind: String,
    pub message: String,
}

impl ErrorOutput {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            error: ErrorBody {
                kind: kind.to_string(),
                message: message.into(),
            },
        }
    }
}
