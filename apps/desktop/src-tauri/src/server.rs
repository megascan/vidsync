//! HTTP file server with Range support (required for video seeking).

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
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

pub struct AppState {
    pub path: PathBuf,
    pub token: String,
    pub mime: String,
    pub file_name: String,
}

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

pub fn router(state: Arc<AppState>) -> Router {
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
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

async fn index(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        format!(
            "VidSync Host\nfile: {}\nmime: {}\nstream: /s/{}\n",
            state.file_name, state.mime, state.token
        ),
    )
}

async fn stream_token(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    stream_inner(state, token, headers).await
}

async fn stream_named(
    State(state): State<Arc<AppState>>,
    AxumPath((token, _name)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    stream_inner(state, token, headers).await
}

async fn stream_inner(state: Arc<AppState>, token: String, headers: HeaderMap) -> Response {
    if token != state.token {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    let meta = match tokio::fs::metadata(&state.path).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "file gone").into_response(),
    };
    let len = meta.len();

    let mut file = match File::open(&state.path).await {
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
                    .header(header::CONTENT_TYPE, state.mime.as_str())
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, content_len)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{len}"),
                    )
                    .header(
                        header::CONTENT_DISPOSITION,
                        format!("inline; filename=\"{}\"", state.file_name),
                    )
                    .body(body)
                    .unwrap_or_else(|e| {
                        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
                    })
            }
            Ok(None) => full_response(file, len, &state).await,
            Err(msg) => Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Body::from(msg))
                .unwrap_or_else(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
                }),
        }
    } else {
        full_response(file, len, &state).await
    }
}

async fn full_response(file: File, len: u64, state: &AppState) -> Response {
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, state.mime.as_str())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", state.file_name),
        )
        .body(body)
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

/// Parse `bytes=start-end` (single range only). Returns inclusive (start, end).
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
