window.__ModuleLoader__.load({
	id: "@apples1949/dsh-speed-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = null;
		try {
			React = require("react") || null;
		} catch (e) {
			React = null;
		}

		if (React === null || typeof React.createElement !== "function") {
			exports.inject = [];
			exports.apply = function apply() {};
			return module.exports;
		}

		var h = React.createElement;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useRef = React.useRef;
		var useState = React.useState;

		var SLOT = "conversation.composer.dock";
		var ENTRY_ID = "speed-meter";
		var ORDER = 10;

		/* ---------------------------------------------------------------- *
		 * Data source
		 * ---------------------------------------------------------------- */

		var EMPTY_NODES = [];
		var EMPTY_CHAT = { legacy: { nodes: EMPTY_NODES, partial: null } };
		var FALLBACK_HOOK = function (selector) {
			return selector(EMPTY_CHAT);
		};

		function selectPartial(snapshot) {
			if (snapshot == null) return null;
			var legacy = snapshot.legacy;
			if (legacy == null) return null;
			return legacy.partial == null ? null : legacy.partial;
		}

		function selectNodes(snapshot) {
			if (snapshot == null) return null;
			var legacy = snapshot.legacy;
			if (legacy == null) return null;
			var nodes = legacy.nodes;
			return Array.isArray(nodes) ? nodes : EMPTY_NODES;
		}


		/* ---------------------------------------------------------------- *
		 * Token estimation
		 *
		 * The stream carries text, not tokens, so the live rate has to be
		 * estimated. Weights follow the published DeepSeek tokenizer ratios
		 * (~0.6 token per CJK character, ~0.25 token per other character,
		 * i.e. the usual four characters per token for English).
		 * ---------------------------------------------------------------- */

		function weightChars(text) {
			if (text.length === 0) return 0;
			var cjk = 0;
			for (var i = 0; i < text.length; i += 1) {
				var code = text.charCodeAt(i);
				if (code < 0x2e80) continue;
				if (code <= 0x9fff) cjk += 1;
				else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
				else if (code >= 0xff00 && code <= 0xffef) cjk += 1;
				else if (code >= 0x3000 && code <= 0x303f) cjk += 1;
			}
			return cjk * 0.6 + (text.length - cjk) * 0.25;
		}

		var WINDOW_MS = 1500;
		var MIN_SPAN_MS = 250;
		var DECAY_MS = 2600;
		// Share of the gap to the new reading closed on each sample; low enough
		// that burst arrival cannot flash a spurious number, high enough to
		// follow a real speed change within a couple of seconds.
		var EASE = 0.18;
		// A measured decode span shorter than this means the whole reply arrived
		// in a burst or two, so the wall clock says nothing about its speed.
		var MIN_DECODE_MS = 600;
		// Above this the measurement is a burst artefact, not a decode rate.
		var MAX_PLAUSIBLE_RATE = 400;

		function nowMs() {
			if (typeof performance !== "undefined" && performance != null && typeof performance.now === "function") {
				return performance.now();
			}
			return Date.now();
		}

		/**
		 * Consume the newest assistant blocks and return the estimated token
		 * gain since the previous pass, or 0 when nothing new arrived.
		 */
		function consumeBlocks(tracker, blocks) {
			var gained = 0;
			var total = 0;
			var restarted = false;
			for (var i = 0; i < blocks.length; i += 1) {
				var block = blocks[i];
				if (block == null) continue;
				var text = "";
				var ascii = false;
				if (block.kind === "text" || block.kind === "reasoning") {
					text = typeof block.text === "string" ? block.text : "";
				} else if (block.kind === "tool-call") {
					text = (typeof block.name === "string" ? block.name : "") + (typeof block.argsRaw === "string" ? block.argsRaw : "");
					ascii = true;
				} else {
					continue;
				}
				total += text.length;
				var previous = tracker.lens[i];
				var previousLength = typeof previous === "number" ? previous : 0;
				if (text.length < previousLength && previousLength > 0) restarted = true;
				if (text.length > previousLength) {
					var added = text.slice(previousLength);
					gained += ascii ? added.length / 4 : weightChars(added);
				}
				tracker.lens[i] = text.length;
			}
			if (restarted && total < tracker.total) {
				tracker.lens = [];
				tracker.samples = [];
				tracker.tokens = 0;
				tracker.start = nowMs();
				tracker.total = 0;
				return 0;
			}
			tracker.total = total;
			return gained;
		}

		/**
		 * Calibration between this meter's character weights and the server's
		 * real `usage.outputTokens`, learned from settled steps so the live
		 * number and the idle average are the same measurement.
		 */
		var calibration = { weighted: 0, tokens: 0, scale: 1 };

		function calibrationScale() {
			if (calibration.weighted > 0 && calibration.tokens > 0) {
				var ratio = calibration.tokens / calibration.weighted;
				if (Number.isFinite(ratio) && ratio > 0) return ratio;
			}
			return 1;
		}

		function teachCalibration(node) {
			if (node == null || node.kind !== "assistant") return false;
			var usage = node.usage;
			var tokens = usage != null && typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
			if (tokens === null || tokens <= 0) return false;
			var blocks = Array.isArray(node.blocks) ? node.blocks : null;
			if (blocks === null) return false;
			var weighted = 0;
			for (var i = 0; i < blocks.length; i += 1) {
				var block = blocks[i];
				if (block == null) continue;
				if (block.kind === "text" || block.kind === "reasoning") {
					weighted += weightChars(typeof block.text === "string" ? block.text : "");
				} else if (block.kind === "tool-call") {
					var raw = (typeof block.name === "string" ? block.name : "") + (typeof block.arguments === "string" ? block.arguments : typeof block.argsRaw === "string" ? block.argsRaw : "");
					weighted += raw.length / 4;
				}
			}
			if (weighted <= 0) return false;
			calibration.weighted = weighted;
			calibration.tokens = tokens;
			calibration.scale = calibrationScale();
			return true;
		}

		/**
		 * The most recent settled assistant step of the log, which is the only
		 * step whose real token count can be matched against its own text.
		 */
		function lastSettledAssistant(nodes) {
			if (nodes == null) return null;
			for (var i = nodes.length - 1; i >= 0; i -= 1) {
				var node = nodes[i];
				if (node != null && node.kind === "assistant") return node;
			}
			return null;
		}

		/* ---------------------------------------------------------------- *
		 * Formatting
		 * ---------------------------------------------------------------- */

		function formatSpeed(value) {
			if (!Number.isFinite(value) || value < 0) return null;
			if (value >= 100) return String(Math.round(value));
			return String(Math.round(value * 10) / 10);
		}

		/**
		 * Average speed of the most recent turn, in tok/s: every assistant step
		 * of the newest turn summed over its decode span. Historical logs carry
		 * no `firstTokenTime`, so a step without one is skipped rather than
		 * charged for its whole span (which would fold in time-to-first-token
		 * and understate the rate by design).
		 */
		function turnSpeed(nodes) {
			if (nodes == null || nodes.length === 0) return null;
			var lastTurn = null;
			var i;
			for (i = 0; i < nodes.length; i += 1) {
				var candidate = nodes[i];
				if (candidate != null && candidate.kind === "assistant" && typeof candidate.turn === "number") lastTurn = candidate.turn;
			}
			if (lastTurn === null) return null;
			var tokens = 0;
			var spanMs = 0;
			var any = false;
			for (i = 0; i < nodes.length; i += 1) {
				var node = nodes[i];
				if (node == null || node.kind !== "assistant" || node.turn !== lastTurn) continue;
				var usage = node.usage;
				var output = usage != null && typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
				if (output === null || output <= 0) continue;
				var timing = node.timing;
				if (timing == null) continue;
				var end = timing.completedTime;
				var from = timing.firstTokenTime;
				if (typeof from !== "number" || typeof end !== "number") continue;
				var span = end - from;
				if (!(span > 0)) continue;
				tokens += output;
				spanMs += span;
				any = true;
			}
			if (!any || spanMs <= 0) return null;
			return tokens / (spanMs / 1000);
		}

		/* ---------------------------------------------------------------- *
		 * Stylesheet
		 * ---------------------------------------------------------------- */

		var CSS = [
			".dsm-root{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 8px;border-radius:999px;",
			"font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);",
			"line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));",
			"color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}",
			".dsm-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary);opacity:.45}",
			".dsm-root[data-streaming='true'] .dsm-dot{background:var(--dsw-alias-brand-primary);opacity:1;animation:dsm-pulse 1.15s ease-in-out infinite}",
			".dsm-value{color:var(--dsw-alias-label-secondary);font-weight:500}",
			".dsm-unit{color:var(--dsw-alias-label-tertiary)}",
			".dsm-tag{color:var(--dsw-alias-label-tertiary);opacity:.8}",
			"@keyframes dsm-pulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}",
		].join("");

		function injectStyle() {
			if (typeof document === "undefined" || document == null) return;
			var tagId = "@apples1949/dsh-speed-meter/speed-meter.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "@apples1949/dsh-speed-meter";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ---------------------------------------------------------------- *
		 * The dock entry
		 * ---------------------------------------------------------------- */

		function SpeedMeter(props) {
			var chat = typeof props.useChat === "function" ? props.useChat : FALLBACK_HOOK;
			var projection = typeof props.useProjection === "function" ? props.useProjection : null;
			var partial = chat(selectPartial);
			var nodes = chat(selectNodes);
			var stats = projection === null ? null : projection("sessionStats");
			var trackerRef = useRef(null);
			// Wall clock span of the step that just finished, captured while it
			// streamed: the settled node's own `firstTokenTime` is absent in this
			// build, so this is the only per-turn decode span available.
			var spanRef = useRef(null);
			// The eased live rate, carried across samples so the display does not
			// jump when the window slides.
			var lastRateRef = useRef(null);
			var state = useState(null);
			var live = state[0];
			var setLive = state[1];
			var measuredState = useState(null);
			var measured = measuredState[0];
			var setMeasured = measuredState[1];

			useEffect(function () {
				if (partial == null) {
					trackerRef.current = null;
					lastRateRef.current = null;
					setLive(function (previous) {
						return previous === null ? previous : null;
					});
					return;
				}
				var now = nowMs();
				var tracker = trackerRef.current;
				if (tracker === null || tracker.turn !== partial.turn || tracker.step !== partial.step) {
					tracker = { turn: partial.turn, step: partial.step, lens: [], samples: [], tokens: 0, start: now, total: 0, firstAt: 0, lastAt: 0 };
					trackerRef.current = tracker;
					lastRateRef.current = null;
				}
				var blocks = Array.isArray(partial.blocks) ? partial.blocks : EMPTY_NODES;
				var gained = consumeBlocks(tracker, blocks);
				if (gained > 0) {
					tracker.tokens += gained;
					tracker.samples.push({ t: now, d: gained });
					if (tracker.firstAt === 0) tracker.firstAt = now;
					tracker.lastAt = now;
					spanRef.current = { turn: tracker.turn, step: tracker.step, firstAt: tracker.firstAt, lastAt: tracker.lastAt, tokens: Math.round(tracker.tokens * calibration.scale) };
				}
				var cutoff = now - WINDOW_MS;
				var index = 0;
				while (index < tracker.samples.length && tracker.samples[index].t < cutoff) index += 1;
				if (index > 0) tracker.samples = tracker.samples.slice(index);
				if (tracker.samples.length === 0) {
					if (now - tracker.start < DECAY_MS) return;
					setLive(function (previous) {
						return previous === 0 ? previous : 0;
					});
					return;
				}
				// Two views of the same stream, both anchored at the first token so
				// neither charges the latch delay to the rate:
				//   stepRate   — everything written since the first token; this is
				//                what the step really sustains, and it is the number
				//                the settled average will agree with.
				//   windowRate — the last WINDOW_MS only, so a genuine stall or
				//                recovery shows up within a second or two.
				// Chunks arrive in bursts, so the window term has to extend its
				// span by one average gap: without that the samples look faster
				// than the interval they were delivered over, and a steady stream
				// read as much as twice its real speed.
				var stepRate = tracker.tokens / (Math.max(now - tracker.firstAt, MIN_SPAN_MS) / 1000);
				var sum = 0;
				for (var i = 0; i < tracker.samples.length; i += 1) sum += tracker.samples[i].d;
				var oldest = tracker.samples[0].t;
				var count = tracker.samples.length;
				var averageGap = count > 1 ? (tracker.lastAt - oldest) / (count - 1) : MIN_SPAN_MS;
				var windowSpan = Math.max(now - oldest + averageGap, MIN_SPAN_MS);
				var windowRate = sum / (windowSpan / 1000);
				var blended = windowRate * 0.7 + stepRate * 0.3;
				var previousRate = lastRateRef.current;
				var eased = previousRate == null ? stepRate : previousRate + (blended - previousRate) * EASE;
				lastRateRef.current = eased;
				var rounded = Math.round(eased * calibration.scale * 10) / 10;
				setLive(function (old) {
					return old === rounded ? old : rounded;
				});
			}, [partial]);

			// Settle: once the step we watched streaming shows up as a settled
			// node, pair its server-side outputTokens with the span we measured.
			useEffect(function () {
				var span = spanRef.current;
				if (span === null || nodes == null) return;
				for (var i = nodes.length - 1; i >= 0; i -= 1) {
					var node = nodes[i];
					if (node == null || node.kind !== "assistant") continue;
					if (node.turn !== span.turn || node.step !== span.step) break;
					var usage = node.usage;
					var tokens = usage != null && typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
					var spanMs = span.lastAt - span.firstAt;
					spanRef.current = null;
					// A reply delivered in one or two bursts has a span of a few
					// milliseconds, and dividing by that reports several hundred
					// tok/s for a normal answer. Below MIN_DECODE_MS the true decode
					// span is simply not observable from the client, so report
					// nothing rather than a wrong number.
					if (tokens > 0 && spanMs >= MIN_DECODE_MS) {
						var rate = tokens / (spanMs / 1000);
						if (Number.isFinite(rate) && rate > 0 && rate <= MAX_PLAUSIBLE_RATE) {
							setMeasured(function (previous) {
								return previous != null && Math.abs(previous.value - rate) < 0.05 ? previous : { value: rate, turn: span.turn, step: span.step };
							});
						}
					}
					return;
				}
			}, [nodes]);

			var average = useMemo(function () {
				teachCalibration(lastSettledAssistant(nodes));
				if (measured != null) return { value: measured.value, scope: "turn" };
				var fromTurn = turnSpeed(nodes);
				if (fromTurn !== null) return { value: fromTurn, scope: "turn" };
				// Logs recorded before `firstTokenTime` existed cannot be split per
				// turn, so the official session-wide decode accumulator answers
				// instead — labelled as such, because it is not this turn.
				if (stats != null && typeof stats.decodeMs === "number" && stats.decodeMs > 0) {
					var tokens = typeof stats.decodeTokens === "number" ? stats.decodeTokens : 0;
					if (tokens > 0) return { value: tokens / (stats.decodeMs / 1000), scope: "session" };
				}
				return null;
			}, [nodes, stats, measured]);

			var streaming = partial != null && live != null && live > 0;
			var value = streaming ? live : average === null ? null : average.value;
			var text = value == null ? null : formatSpeed(value);
			if (text == null) return null;

			var scope = streaming ? "live" : average === null ? null : average.scope;
			var label = scope === "session" ? "会话均值" : scope === "live" ? null : "上轮均值";
			var title =
				scope === "live"
					? "本轮实时输出速度"
					: scope === "session"
						? "整个会话的平均输出速度（当前日志未记录首 token 时间）"
						: "上一轮的平均输出速度";

			return h(
				"span",
				{
					className: "dsm-root",
					"data-dsh-speed-meter": "",
					"data-streaming": streaming ? "true" : "false",
					"data-scope": scope === null ? "none" : scope,
					title: title,
				},
				h("span", { className: "dsm-dot" }),
				label === null ? null : h("span", { className: "dsm-tag" }, label),
				h("span", { className: "dsm-value" }, text),
				h("span", { className: "dsm-unit" }, "tok/s")
			);
		}

		/* ---------------------------------------------------------------- *
		 * Plugin
		 * ---------------------------------------------------------------- */

		function apply(ctx) {
			injectStyle();
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register(
					{
						name: SLOT,
						id: ENTRY_ID,
						order: ORDER,
					},
					SpeedMeter
				);
			});
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
