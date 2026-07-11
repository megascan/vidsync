/**
 * Load /latest.json and wire smart primary / secondary downloads.
 *
 * latest.json:
 * {
 *   version, commit, publishedAt,
 *   windows: { nsis, nsisSize, msi?, msiSize? } | null,
 *   linux:   { appimage, appimageSize, deb?, debSize? } | null
 * }
 *
 * DOM ids:
 *   #dl-primary        primary CTA <a>
 *   #dl-secondary      other-platform <a>
 *   #dl-secondary-wrap wrapper <p> (hidden until ready)
 *   #dl-extras         alt formats (MSI / .deb)
 *   #version-line      version · commit · date
 *
 * Inside primary/secondary: [data-label], [data-meta]
 */

const primary = document.getElementById("dl-primary");
const secondary = document.getElementById("dl-secondary");
const secondaryWrap = document.getElementById("dl-secondary-wrap");
const extras = document.getElementById("dl-extras");
const verLine = document.getElementById("version-line");

/** @returns {"windows" | "linux" | "other"} */
function detectOs() {
  const ua = navigator.userAgent || "";
  const platform =
    /** @type {{ platform?: string } | undefined} */ (navigator).userAgentData
      ?.platform ||
    navigator.platform ||
    "";
  const hay = `${platform} ${ua}`.toLowerCase();

  if (/win/i.test(hay)) return "windows";
  if (/linux/i.test(hay) && !/android/i.test(hay)) return "linux";
  // Chrome OS / Steam Deck etc. often report Linux — already covered
  if (/cros/i.test(hay)) return "linux";
  return "other";
}

/**
 * @param {number | null | undefined} bytes
 * @returns {string | null}
 */
function fmtSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {HTMLAnchorElement | null} el
 * @param {{ href: string | null, label: string, meta: string, download?: boolean }} opts
 */
function setLink(el, opts) {
  if (!el) return;
  const labelEl = el.querySelector("[data-label]") || el;
  const metaEl = el.querySelector("[data-meta]");

  if (labelEl === el) {
    el.textContent = opts.label;
  } else {
    labelEl.textContent = opts.label;
  }
  if (metaEl) metaEl.textContent = opts.meta;

  if (!opts.href) {
    el.setAttribute("aria-disabled", "true");
    el.removeAttribute("href");
    el.removeAttribute("download");
    return;
  }

  el.setAttribute("href", opts.href);
  el.removeAttribute("aria-disabled");
  if (opts.download !== false) el.setAttribute("download", "");
  else el.removeAttribute("download");
}

/**
 * @param {object | null | undefined} w
 * @returns {{ href: string, label: string, size: string | null, kind: string } | null}
 */
function windowsPrimary(w) {
  if (!w?.nsis) return null;
  return {
    href: w.nsis,
    label: "Download for Windows",
    size: fmtSize(w.nsisSize),
    kind: "Installer · x64",
  };
}

/**
 * @param {object | null | undefined} l
 * @returns {{ href: string, label: string, size: string | null, kind: string } | null}
 */
function linuxPrimary(l) {
  if (l?.appimage) {
    return {
      href: l.appimage,
      label: "Download for Linux",
      size: fmtSize(l.appimageSize),
      kind: "AppImage · x64",
    };
  }
  if (l?.deb) {
    return {
      href: l.deb,
      label: "Download for Linux",
      size: fmtSize(l.debSize),
      kind: ".deb · x64",
    };
  }
  return null;
}

/**
 * @param {{ size: string | null, kind: string }} pkg
 * @param {string | null} version
 */
function metaLine(pkg, version) {
  return [version ? `v${version}` : null, pkg.size, pkg.kind]
    .filter(Boolean)
    .join(" · ");
}

/**
 * @param {HTMLElement | null} container
 * @param {{ href: string, label: string, size: string | null }[]} links
 */
function renderExtras(container, links) {
  if (!container) return;
  container.replaceChildren();
  if (!links.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const link of links) {
    const a = document.createElement("a");
    a.href = link.href;
    a.setAttribute("download", "");
    a.textContent = link.size
      ? `${link.label} (${link.size})`
      : link.label;
    container.appendChild(a);
  }
}

/**
 * @param {string} message
 * @param {string} [meta]
 */
function showUnavailable(message, meta = "No builds published yet") {
  primary?.classList.add("is-error");
  primary?.setAttribute("aria-busy", "false");
  setLink(primary, {
    href: null,
    label: message,
    meta,
  });
  if (secondaryWrap) secondaryWrap.hidden = true;
  renderExtras(extras, []);
}

try {
  const res = await fetch("/latest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`latest.json ${res.status}`);
  const data = await res.json();

  const v =
    data.version && data.version !== "0.0.0" ? String(data.version) : null;
  const commit =
    data.commit && data.commit !== "pending"
      ? String(data.commit).slice(0, 7)
      : null;
  const when = data.publishedAt
    ? new Date(data.publishedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  if (verLine) {
    if (v) {
      verLine.textContent = [v ? `v${v}` : null, commit, when]
        .filter(Boolean)
        .join(" · ");
    } else {
      verLine.textContent = "Builds publish automatically from main.";
    }
  }

  const winPkg = windowsPrimary(data.windows);
  const linPkg = linuxPrimary(data.linux);
  const os = detectOs();

  /** @type {ReturnType<typeof windowsPrimary>} */
  let primaryPkg = null;
  /** @type {"windows" | "linux" | null} */
  let primaryOs = null;
  /** @type {ReturnType<typeof windowsPrimary>} */
  let secondaryPkg = null;
  /** @type {"windows" | "linux" | null} */
  let secondaryOs = null;

  if (os === "windows" && winPkg) {
    primaryPkg = winPkg;
    primaryOs = "windows";
    secondaryPkg = linPkg;
    secondaryOs = linPkg ? "linux" : null;
  } else if (os === "linux" && linPkg) {
    primaryPkg = linPkg;
    primaryOs = "linux";
    secondaryPkg = winPkg;
    secondaryOs = winPkg ? "windows" : null;
  } else if (winPkg) {
    // macOS / unknown: prefer Windows as default primary
    primaryPkg = winPkg;
    primaryOs = "windows";
    secondaryPkg = linPkg;
    secondaryOs = linPkg ? "linux" : null;
  } else if (linPkg) {
    primaryPkg = linPkg;
    primaryOs = "linux";
    secondaryPkg = null;
    secondaryOs = null;
  }

  if (!primaryPkg) {
    showUnavailable("Downloads unavailable", "Check back after the next release");
  } else {
    primary?.classList.remove("is-error");
    primary?.setAttribute("aria-busy", "false");
    setLink(primary, {
      href: primaryPkg.href,
      label: primaryPkg.label,
      meta: metaLine(primaryPkg, v),
    });

    if (secondaryPkg && secondaryOs && secondaryWrap && secondary) {
      secondaryWrap.hidden = false;
      const otherLabel =
        secondaryOs === "windows"
          ? "Download for Windows"
          : "Download for Linux";
      setLink(secondary, {
        href: secondaryPkg.href,
        label: otherLabel,
        meta: "",
      });
      const secMeta = secondaryWrap.querySelector("[data-meta]");
      if (secMeta) {
        secMeta.textContent = [secondaryPkg.size, secondaryPkg.kind]
          .filter(Boolean)
          .join(" · ");
      }
    } else if (secondaryWrap) {
      secondaryWrap.hidden = true;
    }

    /** @type {{ href: string, label: string, size: string | null }[]} */
    const alt = [];
    const w = data.windows;
    const l = data.linux;

    // MSI always secondary when present (NSIS is primary Windows package)
    if (w?.msi) {
      alt.push({
        href: w.msi,
        label: "Windows MSI",
        size: fmtSize(w.msiSize),
      });
    }
    // .deb when AppImage is the primary Linux package
    if (l?.appimage && l?.deb) {
      alt.push({
        href: l.deb,
        label: "Linux .deb",
        size: fmtSize(l.debSize),
      });
    }

    renderExtras(extras, alt);
  }
} catch {
  if (verLine) {
    verLine.textContent = "Could not load build info. Try again later.";
  }
  showUnavailable("Could not load downloads", "Refresh the page or try later");
}
