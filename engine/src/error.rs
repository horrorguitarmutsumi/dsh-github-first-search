//! Engine error type — one stable JSON shape for the JS shell to consume.

use std::fmt;

#[derive(Debug)]
pub enum EngineError {
    /// Transport-level failure (DNS, TLS, connection reset…).
    Network(String),
    /// GitHub rate limit hit; carries the optional reset epoch (unix seconds).
    RateLimited {
        message: String,
        reset_epoch: Option<u64>,
    },
    /// GitHub answered with a non-2xx status we did not classify as rate limiting.
    Http {
        status: u16,
        message: String,
    },
    /// A body could not be parsed as expected.
    Parse(String),
    /// Bad local input (bad repo slug, unsupported sort, empty query…).
    Usage(String),
}

impl EngineError {
    /// Stable machine-readable kind, projected into the error JSON.
    pub fn kind(&self) -> &'static str {
        match self {
            EngineError::Network(_) => "network",
            EngineError::RateLimited { .. } => "rate_limited",
            EngineError::Http { .. } => "http",
            EngineError::Parse(_) => "parse",
            EngineError::Usage(_) => "usage",
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Network(message) => write!(f, "network error: {message}"),
            EngineError::RateLimited {
                message,
                reset_epoch,
            } => match reset_epoch {
                Some(epoch) => {
                    write!(f, "GitHub rate limit reached ({message}); resets at unix epoch {epoch}")
                }
                None => write!(f, "GitHub rate limit reached ({message})"),
            },
            EngineError::Http { status, message } => write!(f, "GitHub API HTTP {status}: {message}"),
            EngineError::Parse(message) => write!(f, "failed to parse GitHub response: {message}"),
            EngineError::Usage(message) => write!(f, "invalid usage: {message}"),
        }
    }
}

impl std::error::Error for EngineError {}
