/**
 * Load /latest.json and wire download cards.
 */

const win = document.getElementById("dl-windows");
const lin = document.getElementById("dl-linux");
const verLine = document.getElementById("version-line");

function fmtSize(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wireCard(el, href, label, metaParts) {
  if (!el) return;
  if (!href) {
    el.setAttribute("aria-disabled", "true");
    el.removeAttribute("href");
    const m = el.querySelector("[data-meta]");
    if (m) m.textContent = "Not available yet";
    return;
  }
  el.setAttribute("href", href);
  el.removeAttribute("aria-disabled");
  el.setAttribute("download", "");
  const lab = el.querySelector("[data-label]");
  if (lab && label) lab.textContent = label;
  const m = el.querySelector("[data-meta]");
  if (m) m.textContent = metaParts.filter(Boolean).join(" · ") || "Download";
}

try {
  const res = await fetch("/latest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`latest.json ${res.status}`);
  const data = await res.json();

  const v = data.version && data.version !== "0.0.0" ? data.version : null;
  const commit = data.commit && data.commit !== "pending" ? data.commit.slice(0, 7) : null;
  const when = data.publishedAt
    ? new Date(data.publishedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  if (verLine) {
    if (v) {
      verLine.textContent = [
        `v${v}`,
        commit ? commit : null,
        when ? when : null,
      ]
        .filter(Boolean)
        .join(" · ");
    } else {
      verLine.textContent = "Builds publish automatically from main.";
    }
  }

  const w = data.windows;
  if (w?.nsis) {
    wireCard(win, w.nsis, "Download installer", [
      fmtSize(w.nsisSize),
      "x64",
    ]);
    win?.classList.add("primary-dl");
  } else {
    wireCard(win, null);
  }

  const l = data.linux;
  if (l?.appimage) {
    wireCard(lin, l.appimage, "Download AppImage", [
      fmtSize(l.appimageSize),
      "x64",
    ]);
  } else if (l?.deb) {
    wireCard(lin, l.deb, "Download .deb", [fmtSize(l.debSize), "x64"]);
  } else {
    wireCard(lin, null);
  }
} catch {
  if (verLine) {
    verLine.textContent = "Could not load build info. Try again later.";
  }
  wireCard(win, null);
  wireCard(lin, null);
}
