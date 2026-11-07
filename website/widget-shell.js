// A finite presentation controller. Same mounted chat/form, no model calls or generated code.
(function (root) {
  "use strict";
  root.FrontsmithWidgetShell = function (config, paint, random) {
    var allowed = ["object", "question", "conversation", "form", "result"];
    var previous = Object.create(null);
    var state = null;
    var tone = 0;
    random = random || Math.random;
    function enter(next) {
      if (allowed.indexOf(next) < 0 || state === next) return;
      if (previous[next] === undefined) tone = 0;
      else {
        var count = config.tones && config.tones.length || 1;
        var candidates = Array.from({ length: count }, function (_, i) { return i; }).filter(function (i) { return i !== previous[next]; });
        tone = candidates.length ? candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))] : 0;
      }
      previous[next] = tone;
      state = next;
      paint(state, config.tones && config.tones[tone], tone);
    }
    return { enter: enter, refresh: function () { if (state) paint(state, config.tones && config.tones[tone], tone); }, state: function () { return state; } };
  };
})(globalThis);
