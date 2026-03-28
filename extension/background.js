// Auto-capture on browser action click (simulated via CDP)
chrome.browserAction.onClicked.addListener((tab) => {
  chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
    if (stream) {
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(1000);
      self._recorder = recorder;
      self._chunks = chunks;
      self._stream = stream;
      self._capturing = true;
      console.log("Tab audio capture started for tab", tab.id);
    } else {
      console.error("Tab capture failed:", chrome.runtime.lastError?.message);
    }
  });
});
