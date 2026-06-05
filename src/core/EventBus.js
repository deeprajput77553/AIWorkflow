// src/core/EventBus.js
// Typed pub/sub event bus for clean inter-stage signaling

export const AGENT_EVENTS = {
    // Input stage
    INPUT_RECEIVED:      'input:received',
    BUILTIN_COMMAND:     'input:builtin',

    // Context stage
    CONTEXT_BUILT:       'context:built',
    SNAPSHOT_CACHED:     'context:snapshot_cached',

    // Router stage
    PRE_ROUTER_HIT:      'router:pre_hit',
    ROUTE_DECIDED:       'router:decided',
    MULTI_INTENT:        'router:multi_intent',
    LOW_CONFIDENCE:      'router:low_confidence',

    // Execution stage
    EXECUTION_STARTED:   'exec:started',
    TOOL_CALLED:         'exec:tool_called',
    TOOL_RESULT:         'exec:tool_result',
    TOOL_ERROR:          'exec:tool_error',
    EXECUTION_DONE:      'exec:done',

    // Streaming
    STREAM_TOKEN:        'stream:token',
    STREAM_DONE:         'stream:done',

    // Reflection stage
    PLAN_CREATED:        'reflect:plan_created',
    PLAN_CRITIQUED:      'reflect:plan_critiqued',
    SELF_CORRECTION:     'reflect:self_correction',
    VERIFICATION_DONE:   'reflect:verification_done',

    // Output stage
    OUTPUT_READY:        'output:ready',

    // System
    ERROR:               'system:error',
    LOOP_RESET:          'system:loop_reset',
    PROFILE_UPDATED:     'system:profile_updated',
    WS_CLIENT_CONNECTED: 'system:ws_connected',
};

class EventBus {
    constructor() {
        this._listeners = new Map();
        this._history   = [];   // last 100 events for dashboard replay
    }

    /**
     * Subscribe to an event.
     * @returns {Function} unsubscribe function
     */
    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
        return () => this.off(event, handler);
    }

    /** Subscribe once, auto-unsubscribes after first fire */
    once(event, handler) {
        const unsub = this.on(event, (data) => { handler(data); unsub(); });
        return unsub;
    }

    off(event, handler) {
        if (!this._listeners.has(event)) return;
        this._listeners.set(event, this._listeners.get(event).filter(h => h !== handler));
    }

    emit(event, payload = {}) {
        const envelope = { type: event, payload, timestamp: new Date().toISOString() };
        this._history.push(envelope);
        if (this._history.length > 100) this._history.shift();

        const handlers = this._listeners.get(event) || [];
        handlers.forEach(h => {
            try { h(envelope); }
            catch (err) { /* isolate handler errors */ }
        });
        // Wildcard listeners
        const wildcards = this._listeners.get('*') || [];
        wildcards.forEach(h => {
            try { h(envelope); }
            catch { /* isolate */ }
        });
    }

    /** Returns recent event history — used by dashboard on new connection */
    getHistory(n = 50) {
        return this._history.slice(-n);
    }
}

export const bus = new EventBus();
export default EventBus;
