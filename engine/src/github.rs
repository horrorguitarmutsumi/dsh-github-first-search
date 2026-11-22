//! GitHub REST access: repository search + README fetch.
//!
//! Anonymous access works (10 search req/min per IP); a `GITHUB_TOKEN` raises
//! the quota (30/min search, 5000/hr core). The JS shell resolves the DSH
//! `GITHUB_TOKEN` credential and forwards it via the process environment.

use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;

use crate::error::EngineError;
use crate::models::{ReadmeOutput, RepoHit};

const API_ROOT: &str = "https://api.github.com";
const USER_AGENT: &str = "dsh-github-first-search";
const SEARCH_SORTS: [&str; 3] = ["stars", "forks", "updated"];

/// Compose the final `q` parameter: user keywords + optional qualifiers.
pub fn build_search_query(query: &str, language: Option<&str>, min_stars: Option<u64>) -> String {
    let mut out = query.trim().to_string();
    if let Some(lang) = language.map(str::trim).filter(|lang| !lang.is_empty()) {
        out.push_str(" language:");
        out.push_str(lang);
    }
    if let Some(stars) = min_stars {
        out.push_str(&format!(" stars:>={stars}"));
    }
    out
}

/// Percent-encode a query-string component (UTF-8, unreserved set kept raw).
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Validate an `owner/name` slug; returns the trimmed slug on success.
pub fn validate_repo_slug(slug: &str) -> Result<&str, EngineError> {
    let trimmed = slug.trim();
    let parts: Vec<&str> = trimmed.split('/').collect();
    let ok = parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty() && !part.chars().any(|c: char| c.is_whitespace())
        })
        && !trimmed.contains("://");
    if ok {
        Ok(trimmed)
    } else {
        Err(EngineError::Usage(format!(
            "repo must be in owner/name form, got: {slug:?}"
        )))
    }
}

/// Classify one HTTP attempt: HTTP error statuses arrive as `Err` in ureq 2.
fn classify_call(result: Result<ureq::Response, ureq::Error>) -> Result<ureq::Response, EngineError> {
    match result {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(status, response)) => {
            if status == 403 || status == 429 {
                let reset = response
                    .header("x-ratelimit-reset")
                    .and_then(|value| value.parse::<u64>().ok());
                let message = response
                    .header("x-ratelimit-remaining")
                    .map(|remaining| format!("remaining={remaining}"))
                    .unwrap_or_else(|| "quota exceeded".to_string());
                Err(EngineError::RateLimited {
                    message,
                    reset_epoch: reset,
                })
            } else {
                Err(EngineError::Http {
                    status,
                    message: format!("endpoint returned HTTP {status}"),
                })
            }
        }
        Err(error) => Err(EngineError::Network(error.to_string())),
    }
}

fn get_json(url: &str, token: Option<&str>, timeout: Duration) -> Result<Value, EngineError> {
    let mut request = ureq::get(url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .timeout(timeout);
    if let Some(token) = token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let response = classify_call(request.call())?;
    response
        .into_json::<Value>()
        .map_err(|error| EngineError::Parse(error.to_string()))
}

/// Inputs for one repository search.
pub struct SearchInput<'a> {
    pub query: &'a str,
    pub sort: Option<&'a str>,
    pub per_page: usize,
}

/// Live repository search; returns `(total_count, hits)`.
pub fn search_repos(
    token: Option<&str>,
    input: &SearchInput<'_>,
    timeout: Duration,
) -> Result<(u64, Vec<RepoHit>), EngineError> {
    if let Some(sort) = input.sort.filter(|sort| !sort.is_empty() && *sort != "best-match") {
        if !SEARCH_SORTS.contains(&sort) {
            return Err(EngineError::Usage(format!(
                "unsupported sort {sort:?}; expected stars | forks | updated | best-match"
            )));
        }
    }
    let per_page = input.per_page.clamp(1, 100);
    let mut url = format!(
        "{API_ROOT}/search/repositories?q={}&per_page={per_page}",
        percent_encode(input.query)
    );
    if let Some(sort) = input.sort.filter(|sort| !sort.is_empty() && *sort != "best-match") {
        url.push_str(&format!("&sort={sort}&order=desc"));
    }
    let body = get_json(&url, token, timeout)?;
    parse_search_response(&body)
}

/// Map one GitHub search payload into the canonical shape (unit-tested offline).
pub fn parse_search_response(body: &Value) -> Result<(u64, Vec<RepoHit>), EngineError> {
    let total = body.get("total_count").and_then(Value::as_u64).unwrap_or(0);
    let items = body
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| EngineError::Parse("search payload has no items array".to_string()))?;
    let hits = items
        .iter()
        .map(|item| RepoHit {
            full_name: text(item, "full_name"),
            html_url: text(item, "html_url"),
            description: text(item, "description"),
            stars: item
                .get("stargazers_count")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            forks: item.get("forks_count").and_then(Value::as_u64).unwrap_or(0),
            language: item
                .get("language")
                .and_then(Value::as_str)
                .map(str::to_string),
            topics: item
                .get("topics")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            updated_at: text(item, "updated_at"),
            open_issues: item
                .get("open_issues_count")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
        .collect();
    Ok((total, hits))
}

/// Fetch a repository README as plain markdown, capped at `max_chars` characters.
pub fn fetch_readme(
    token: Option<&str>,
    slug: &str,
    max_chars: usize,
    timeout: Duration,
) -> Result<ReadmeOutput, EngineError> {
    let slug = validate_repo_slug(slug)?;
    let body = get_json(&format!("{API_ROOT}/repos/{slug}/readme"), token, timeout)?;
    let encoded = body
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Parse("readme payload has no content field".to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.replace(['\n', '\r'], ""))
        .map_err(|error| EngineError::Parse(format!("readme content is not valid base64: {error}")))?;
    let full = String::from_utf8_lossy(&bytes);
    let mut truncated = false;
    let mut content = full.as_ref().to_string();
    if content.chars().count() > max_chars {
        truncated = true;
        content = content.chars().take(max_chars).collect();
    }
    Ok(ReadmeOutput {
        repo: slug.to_string(),
        path: text(&body, "path"),
        html_url: text(&body, "html_url"),
        content,
        truncated,
    })
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_query_appends_qualifiers() {
        assert_eq!(
            build_search_query("todo app", Some("rust"), Some(100)),
            "todo app language:rust stars:>=100"
        );
        assert_eq!(build_search_query("  spaced  ", None, None), "spaced");
        assert_eq!(build_search_query("cli", Some("  "), None), "cli");
    }

    #[test]
    fn percent_encode_keeps_unreserved_raw() {
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(percent_encode("todo app"), "todo%20app");
        assert_eq!(percent_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn repo_slug_validation() {
        assert_eq!(validate_repo_slug(" tokio-rs/tokio ").unwrap(), "tokio-rs/tokio");
        assert!(validate_repo_slug("https://github.com/a/b").is_err());
        assert!(validate_repo_slug("only-name").is_err());
        assert!(validate_repo_slug("a//b").is_err());
    }

    #[test]
    fn parse_search_response_maps_fields() {
        let body = json!({
            "total_count": 2,
            "items": [
                {
                    "full_name": "u/r",
                    "html_url": "https://github.com/u/r",
                    "description": "demo",
                    "stargazers_count": 1234,
                    "forks_count": 12,
                    "language": "Rust",
                    "topics": ["cli"],
                    "updated_at": "2026-01-02T00:00:00Z",
                    "open_issues_count": 3
                },
                {
                    "full_name": "x/y",
                    "html_url": "https://github.com/x/y"
                }
            ]
        });
        let (total, hits) = parse_search_response(&body).unwrap();
        assert_eq!(total, 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].stars, 1234);
        assert_eq!(hits[0].forks, 12);
        assert_eq!(hits[0].topics, vec!["cli"]);
        assert_eq!(hits[1].description, "");
        assert_eq!(hits[1].language, None);
        assert_eq!(hits[1].stars, 0);
    }

    #[test]
    fn parse_search_response_rejects_missing_items() {
        assert!(parse_search_response(&json!({ "total_count": 0 })).is_err());
    }
}
