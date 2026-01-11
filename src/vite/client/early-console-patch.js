(function () {
  if (
    window.location.hostname !== "localhost" &&
    !window.location.hostname.match(/127\\.0\\.0\\.1/)
  )
    return;

  window.__earlyConsoleLogs = [];
  window.__originalConsole = {};

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    window.__originalConsole[level] = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      window.__earlyConsoleLogs.push({
        level: level,
        args: args,
        timestamp: Date.now(),
      });
      window.__originalConsole[level].apply(console, args);
    };
  });
})();
