//! HTTP multi-file server with Range support (seek).

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rand::Rng;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct FileEntry {
    pub path: PathBuf,
    pub mime: String,
    pub file_name: String,
}

pub type FileRegistry = Arc<RwLock<HashMap<String, FileEntry>>>;

pub fn random_token() -> String {
    const ALPH: &[u8] = b"abcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| ALPH[rng.gen_range(0..ALPH.len())] as char)
        .collect()
}

pub fn guess_mime(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_string()
}

pub fn router(registry: FileRegistry) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            header::ACCEPT_RANGES,
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::CONTENT_TYPE,
        ]);

    Router::new()
        .route("/", get(index))
        .route("/s/{token}", get(stream_token))
        .route("/s/{token}/{name}", get(stream_named))
        .with_state(registry)
        .layer(cors)
}

async fn index(State(reg): State<FileRegistry>) -> impl IntoResponse {
    let n = reg.read().await.len();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        format!("VidSync Host\nfiles: {n}\n"),
    )
}

async fn stream_token(
    State(reg): State<FileRegistry>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    stream_inner(reg, token, headers).await
}

async fn stream_named(
    State(reg): State<FileRegistry>,
    AxumPath((token, _name)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    stream_inner(reg, token, headers).await
}

async fn stream_inner(reg: FileRegistry, token: String, headers: HeaderMap) -> Response {
    let entry = {
        let map = reg.read().await;
        map.get(&token).cloned()
    };
    let Some(entry) = entry else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };

    let meta = match tokio::fs::metadata(&entry.path).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "file gone").into_response(),
    };
    let len = meta.len();

    let mut file = match File::open(&entry.path).await {
        Ok(f) => f,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "open failed").into_response();
        }
    };

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if let Some(range) = range_header {
        match parse_single_bytes_range(&range, len) {
            Ok(Some((start, end))) => {
                let content_len = end - start + 1;
                if let Err(e) = file.seek(SeekFrom::Start(start)).await {
                    return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
                }
                let limited = file.take(content_len);
                let stream = ReaderStream::new(limited);
                let body = Body::from_stream(stream);

                Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, entry.mime.as_str())
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, content_len)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{len}"),
                    )
                    .header(
                        header::CONTENT_DISPOSITION,
                        format!("inline; filename=\"{}\"", entry.file_name),
                    )
                    .body(body)
                    .unwrap_or_else(|e| {
                        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
                    })
            }
            Ok(None) => full_response(file, len, &entry).await,
            Err(msg) => Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Body::from(msg))
                .unwrap_or_else(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
                }),
        }
    } else {
        full_response(file, len, &entry).await
    }
}

async fn full_response(file: File, len: u64, entry: &FileEntry) -> Response {
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, entry.mime.as_str())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", entry.file_name),
        )
        .body(body)
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

fn parse_single_bytes_range(header: &str, file_len: u64) -> Result<Option<(u64, u64)>, String> {
    let header = header.trim();
    if !header.starts_with("bytes=") {
        return Err("only bytes ranges supported".into());
    }
    let spec = header[6..].trim();
    if spec.contains(',') {
        return Err("multiple ranges not supported".into());
    }
    if file_len == 0 {
        return Ok(None);
    }

    let (start_s, end_s) = spec
        .split_once('-')
        .ok_or_else(|| "bad range".to_string())?;

    if start_s.is_empty() {
        let n: u64 = end_s.parse().map_err(|_| "bad suffix".to_string())?;
        if n == 0 {
            return Err("empty range".into());
        }
        let n = n.min(file_len);
        let start = file_len - n;
        return Ok(Some((start, file_len - 1)));
    }

    let start: u64 = start_s.parse().map_err(|_| "bad start".to_string())?;
    if start >= file_len {
        return Err("start past EOF".into());
    }
    let end = if end_s.is_empty() {
        file_len - 1
    } else {
        let e: u64 = end_s.parse().map_err(|_| "bad end".to_string())?;
        e.min(file_len - 1)
    };
    if end < start {
        return Err("end < start".into());
    }
    Ok(Some((start, end)))
}
