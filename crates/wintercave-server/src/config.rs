//! Command line and environment parsing.

use std::collections::HashMap;

pub const USAGE: &str = "\
WinterCave — the local editor server

Usage: wintercave-server [options]

  -p, --port <n>      port to listen on (default 4173, or $PORT; 0 picks a free port)
      --host <addr>   address to bind (default 0.0.0.0, or $HOST)
      --root <dir>    directory the editor may read/write (default .)
      --read-only     open files, refuse writes
      --max-bytes <n> largest file accepted, in bytes
  -h, --help          show this help

Point a browser at the printed address, or pass --host 127.0.0.1 to keep the
server off the network entirely.";

pub const DEFAULT_PORT: u16 = 4173;
pub const DEFAULT_HOST: &str = "0.0.0.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub root: String,
    pub read_only: bool,
    pub max_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            host: DEFAULT_HOST.to_string(),
            root: ".".to_string(),
            read_only: false,
            max_bytes: crate::files::DEFAULT_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseOutcome {
    Run(Config),
    Help,
}

fn number<T: std::str::FromStr>(raw: &str, label: &str) -> Result<T, String> {
    raw.parse::<T>()
        .map_err(|_| format!("{label} must be a positive number, got {raw:?}"))
}

/// The value of a flag: either inline (`--port=1`) or the next argument.
fn take(
    args: &[String],
    index: &mut usize,
    inline: Option<&str>,
    label: &str,
) -> Result<String, String> {
    if let Some(value) = inline {
        return Ok(value.to_string());
    }
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("{label} needs a value"))
}

pub fn parse_args(args: &[String], env: &HashMap<String, String>) -> Result<ParseOutcome, String> {
    let mut config = Config::default();
    if let Some(port) = env.get("PORT") {
        config.port = number(port, "port")?;
    }
    if let Some(host) = env.get("HOST") {
        config.host = host.clone();
    }
    if let Some(root) = env.get("WINTERCAVE_ROOT") {
        config.root = root.clone();
    }

    let mut index = 0;
    while index < args.len() {
        let raw = args[index].clone();
        let (flag, inline) = match raw.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (raw.clone(), None),
        };

        let inline = inline.as_deref();
        match flag.as_str() {
            "-p" | "--port" => {
                config.port = number(&take(args, &mut index, inline, "--port")?, "--port")?;
            }
            "--host" => config.host = take(args, &mut index, inline, "--host")?,
            "--root" => config.root = take(args, &mut index, inline, "--root")?,
            "--read-only" => config.read_only = true,
            "--max-bytes" => {
                config.max_bytes = number(
                    &take(args, &mut index, inline, "--max-bytes")?,
                    "--max-bytes",
                )?;
            }
            "-h" | "--help" => return Ok(ParseOutcome::Help),
            "" => {}
            other => return Err(format!("Unknown option: {other}")),
        }

        index += 1;
    }

    Ok(ParseOutcome::Run(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn run(values: &[&str]) -> Config {
        match parse_args(&args(values), &HashMap::new()).unwrap() {
            ParseOutcome::Run(config) => config,
            ParseOutcome::Help => panic!("expected a runnable config"),
        }
    }

    #[test]
    fn defaults_are_local_and_bounded() {
        let config = run(&[]);
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.host, DEFAULT_HOST);
        assert_eq!(config.root, ".");
        assert!(!config.read_only);
        assert_eq!(config.max_bytes, crate::files::DEFAULT_MAX_BYTES);
    }

    #[test]
    fn reads_flags_with_and_without_equals() {
        let config = run(&[
            "--port=8080",
            "--host",
            "127.0.0.1",
            "--root",
            "/tmp/ws",
            "--max-bytes=2048",
            "--read-only",
        ]);
        assert_eq!(config.port, 8080);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.root, "/tmp/ws");
        assert_eq!(config.max_bytes, 2048);
        assert!(config.read_only);
    }

    #[test]
    fn help_and_errors() {
        assert_eq!(
            parse_args(&args(&["-h"]), &HashMap::new()).unwrap(),
            ParseOutcome::Help
        );
        assert!(parse_args(&args(&["--nope"]), &HashMap::new()).is_err());
        assert!(parse_args(&args(&["--port"]), &HashMap::new()).is_err());
        assert!(parse_args(&args(&["--port", "abc"]), &HashMap::new()).is_err());
    }

    #[test]
    fn environment_provides_defaults() {
        let mut env = HashMap::new();
        env.insert("PORT".to_string(), "5000".to_string());
        env.insert("HOST".to_string(), "127.0.0.1".to_string());
        env.insert("WINTERCAVE_ROOT".to_string(), "/tmp/env-root".to_string());
        let config = match parse_args(&[], &env).unwrap() {
            ParseOutcome::Run(config) => config,
            ParseOutcome::Help => panic!("expected a runnable config"),
        };
        assert_eq!(config.port, 5000);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.root, "/tmp/env-root");
    }
}
