//! github-first — the GitHub-first research engine behind the dsh-github-first-search plugin.
//!
//! Process contract with the JS shell (`../src/engine.ts`): one spawn per call,
//! argv in, a single JSON document on stdout. Exit 0 → result for the
//! subcommand; exit 1 → `{"error": {"kind": …, "message": …}}`.

mod error;
mod github;
mod models;

use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};

use error::EngineError;
use models::{ErrorOutput, SearchOutput};

#[derive(Parser)]
#[command(
    name = "github-first",
    version,
    about = "GitHub-first research engine: GitHub repository search + README fetch (JSON on stdout)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Search GitHub repositories (GitHub qualifiers pass through as-is).
    Search {
        /// Keywords or natural-language phrase, e.g. "terminal ui" or "cli framework".
        #[arg(long)]
        query: String,
        /// Maximum number of results (1-20).
        #[arg(long, default_value_t = 8)]
        limit: usize,
        /// Sort order: stars | forks | updated | best-match.
        #[arg(long)]
        sort: Option<String>,
        /// Language filter, e.g. rust / typescript / go.
        #[arg(long)]
        language: Option<String>,
        /// Minimum star count.
        #[arg(long)]
        min_stars: Option<u64>,
        /// Per-request timeout in seconds.
        #[arg(long, default_value_t = 25)]
        timeout_secs: u64,
    },
    /// Fetch a repository README as markdown (capped at 20k chars by default).
    Readme {
        /// Repository in owner/name form, e.g. tokio-rs/tokio.
        #[arg()]
        repo: String,
        /// Maximum number of characters returned.
        #[arg(long, default_value_t = 20000)]
        max_chars: usize,
        /// Per-request timeout in seconds.
        #[arg(long, default_value_t = 25)]
        timeout_secs: u64,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let token = std::env::var("GITHUB_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty());
    let outcome = match cli.command {
        Command::Search {
            query,
            limit,
            sort,
            language,
            min_stars,
            timeout_secs,
        } => run_search(
            &query,
            limit,
            sort.as_deref(),
            language.as_deref(),
            min_stars,
            token.as_deref(),
            Duration::from_secs(timeout_secs),
        ),
        Command::Readme {
            repo,
            max_chars,
            timeout_secs,
        } => github::fetch_readme(token.as_deref(), &repo, max_chars, Duration::from_secs(timeout_secs))
            .and_then(|value| {
                serde_json::to_string(&value).map_err(|error| EngineError::Parse(error.to_string()))
            }),
    };
    match outcome {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            let doc = ErrorOutput::new(error.kind(), error.to_string());
            println!(
                "{}",
                serde_json::to_string(&doc)
                    .unwrap_or_else(|_| r#"{"error":{"kind":"internal","message":"engine failure"}}"#.to_string())
            );
            ExitCode::FAILURE
        }
    }
}

fn run_search(
    query: &str,
    limit: usize,
    sort: Option<&str>,
    language: Option<&str>,
    min_stars: Option<u64>,
    token: Option<&str>,
    timeout: Duration,
) -> Result<String, EngineError> {
    let composed = github::build_search_query(query, language, min_stars);
    if composed.is_empty() {
        return Err(EngineError::Usage("query must not be empty".to_string()));
    }
    let per_page = limit.clamp(1, 20);
    let (total_count, results) = github::search_repos(
        token,
        &github::SearchInput {
            query: &composed,
            sort,
            per_page,
        },
        timeout,
    )?;
    let output = SearchOutput {
        query: composed,
        total_count,
        results,
    };
    serde_json::to_string(&output).map_err(|error| EngineError::Parse(error.to_string()))
}
