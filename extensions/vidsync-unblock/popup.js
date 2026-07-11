const ver = chrome.runtime.getManifest().version;
document.getElementById("ver").textContent = `v${ver}`;

document.getElementById("open").addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://vidsync.ratt.ing/" });
});

// Reflect whether the active tab is VidSync
void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  const url = tabs[0]?.url ?? "";
  const onVid =
    url.startsWith("https://vidsync.ratt.ing") ||
    url.startsWith("http://localhost:4321") ||
    url.startsWith("http://127.0.0.1:4321");
  const el = document.getElementById("status");
  if (onVid) {
    el.textContent = "Active on this VidSync tab";
    el.className = "ok";
  } else {
    el.textContent = "Open a VidSync tab to use Unblock";
    el.className = "warn";
  }
});
