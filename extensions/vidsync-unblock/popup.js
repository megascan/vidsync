const ver = chrome.runtime.getManifest().version;
document.getElementById("ver").textContent = `v${ver}`;
