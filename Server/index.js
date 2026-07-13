#!/usr/bin/env node
import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const e = React.createElement;

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const MAX_LOGS = 300;
const VISIBLE_LOGS = 9;

// ────────────────────────────────────────────────────────────
// Shared state + tiny pub/sub (no extra deps)
// ────────────────────────────────────────────────────────────
const state = {
    clients: new Map(), // id -> info
    totalExecutes: 0,
    logs: [],
    startedAt: Date.now(),
};

let listeners = [];
function notify() {
    for (const fn of listeners) fn();
}
function subscribe(fn) {
    listeners.push(fn);
    return () => {
        listeners = listeners.filter((f) => f !== fn);
    };
}

function log(type, text) {
    state.logs.push({ id: randomUUID(), time: new Date(), type, text });
    if (state.logs.length > MAX_LOGS) state.logs.shift();
    notify();
}

function short(id) {
    return id.slice(0, 8);
}

// ────────────────────────────────────────────────────────────
// WebSocket server (original logic, instrumented)
// ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

const broadcast = (message) => {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
        client.send(payload);
    });
};

const handlers = {
    ping: (_, ws) => {
        ws.send("pong");
    },
    register: (msg, ws) => {
        if (!msg.role) return;
        ws.role = msg.role;
        ws.executor = msg.executor || "unknown";
        ws.version = msg.version || "unknown";
        ws.account = msg.account || "unknown";
        ws.place = msg.place || "unknown";
        ws.job = msg.job || "unknown";

        const info = state.clients.get(ws.__id);
        if (info) {
            info.role = ws.role;
            info.executor = ws.executor;
            info.version = ws.version;
            info.account = ws.account;
        }

        ws.send(JSON.stringify({ type: "registered", role: ws.role }));
        broadcast({
            type: "registered",
            role: ws.role,
            executor: ws.executor,
            version: ws.version,
            account: ws.account,
        });

        log(
            "register",
            `${short(ws.__id)} registered as ${ws.role}` +
                (ws.role === "executor"
                    ? ` (${ws.executor} v${ws.version} \u00b7 ${ws.account})`
                    : ""),
        );
    },
    executed: (_, ws) => {
        broadcast({ type: "execute", payload: null });
        log("event", `${short(ws.__id)} sent 'executed'`);
    },
    execute: (msg, ws) => {
        const payload = msg.payload === undefined ? null : msg.payload;
        broadcast({ type: "execute", payload });
        ws.send(JSON.stringify({ type: "forwarded" }));
        state.totalExecutes += 1;
        log(
            "execute",
            `execute forwarded from ${short(ws.__id)} (#${state.totalExecutes})`,
        );
        notify();
    },
    getExecutors: (_, ws) => {
        const executors = Array.from(wss.clients)
            .filter((client) => client.role === "executor")
            .map((client) => ({
                executor: client.executor,
                version: client.version,
                account: client.account,
            }));
        ws.send(JSON.stringify({ type: "executors", executors }));
        log(
            "event",
            `${short(ws.__id)} requested executor list (${executors.length})`,
        );
    },
};

wss.on("connection", (ws, req) => {
    ws.__id = randomUUID();
    ws.role = "client";
    ws.executor = "unknown";
    ws.version = "unknown";
    ws.account = "unknown";

    const ip = req.socket.remoteAddress || "unknown";

    state.clients.set(ws.__id, {
        id: ws.__id,
        role: ws.role,
        executor: ws.executor,
        version: ws.version,
        account: ws.account,
        ip,
        connectedAt: Date.now(),
    });

    log("connect", `client ${short(ws.__id)} connected from ${ip}`);

    ws.on("message", (message) => {
        let msg = message.toString();
        try {
            msg = JSON.parse(msg);
        } catch (e) {}

        const type = typeof msg === "string" ? msg : msg && msg.type;
        const handler = handlers[type];

        log("recv", `${short(ws.__id)} -> ${type || "unknown"}`);

        if (handler) {
            handler(msg, ws);
        }
    });

    ws.on("close", () => {
        state.clients.delete(ws.__id);
        log("disconnect", `client ${short(ws.__id)} disconnected`);
    });

    ws.on("error", (err) => {
        log("error", `${short(ws.__id)} error: ${err.message}`);
    });
});

// ────────────────────────────────────────────────────────────
// Ink dashboard (built with React.createElement — no JSX,
// so this runs on plain `node index.js`, no build step needed)
// ────────────────────────────────────────────────────────────

function useTick(intervalMs) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const unsub = subscribe(() => setTick((t) => t + 1));
        let timer;
        if (intervalMs) {
            timer = setInterval(() => setTick((t) => t + 1), intervalMs);
        }
        return () => {
            unsub();
            if (timer) clearInterval(timer);
        };
    }, [intervalMs]);
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
}

function pad(str, len) {
    str = String(str ?? "");
    if (str.length > len) return str.slice(0, len - 1) + "\u2026";
    return str.padEnd(len);
}

const LOG_COLORS = {
    connect: "green",
    disconnect: "red",
    register: "cyan",
    execute: "yellow",
    event: "magenta",
    recv: "gray",
    error: "redBright",
};

const LOG_ICONS = {
    connect: "+",
    disconnect: "-",
    register: "*",
    execute: ">",
    event: "~",
    recv: ".",
    error: "!",
};

function StatBox({ label, value, color }) {
    return e(
        Box,
        {
            borderStyle: "round",
            borderColor: color,
            flexDirection: "column",
            paddingX: 2,
            marginRight: 1,
        },
        e(Text, { color, bold: true }, label),
        e(Text, { bold: true }, String(value)),
    );
}

function ConnectionsTable({ clients }) {
    const rows = Array.from(clients.values()).sort(
        (a, b) => a.connectedAt - b.connectedAt,
    );

    const header = e(
        Box,
        null,
        e(
            Text,
            { dimColor: true },
            pad("ID", 10) +
                pad("ROLE", 10) +
                pad("EXECUTOR", 16) +
                pad("VERSION", 10) +
                pad("ACCOUNT", 14) +
                pad("UPTIME", 9),
        ),
    );

    const emptyRow =
        rows.length === 0
            ? e(Text, { dimColor: true, italic: true }, "(no connections yet)")
            : null;

    const rowEls = rows.map((c) => {
        const isExecutor = c.role === "executor";
        const roleColor = isExecutor ? "yellowBright" : "greenBright";
        return e(
            Box,
            { key: c.id },
            e(Text, { color: roleColor }, pad(short(c.id), 10)),
            e(Text, { color: roleColor, bold: true }, pad(c.role, 10)),
            e(
                Text,
                { color: isExecutor ? "white" : "gray" },
                pad(isExecutor ? c.executor : "-", 16),
            ),
            e(
                Text,
                { color: isExecutor ? "white" : "gray" },
                pad(isExecutor ? c.version : "-", 10),
            ),
            e(
                Text,
                { color: isExecutor ? "white" : "gray" },
                pad(isExecutor ? c.account : "-", 14),
            ),
            e(
                Text,
                { dimColor: true },
                pad(formatDuration(Date.now() - c.connectedAt), 9),
            ),
        );
    });

    return e(
        Box,
        {
            borderStyle: "round",
            borderColor: "blueBright",
            flexDirection: "column",
            paddingX: 1,
        },
        e(
            Text,
            { bold: true, color: "blueBright" },
            `CONNECTIONS (${rows.length})`,
        ),
        header,
        emptyRow,
        ...rowEls,
    );
}

function LogBox({ logs }) {
    const visible = logs.slice(-VISIBLE_LOGS);

    const emptyRow =
        visible.length === 0
            ? e(Text, { dimColor: true, italic: true }, "(no events yet)")
            : null;

    const rowEls = visible.map((entry) => {
        const color = LOG_COLORS[entry.type] || "white";
        const icon = LOG_ICONS[entry.type] || "*";
        const ts = entry.time.toTimeString().slice(0, 8);
        return e(
            Text,
            { key: entry.id },
            e(Text, { dimColor: true }, ts + " "),
            e(Text, { color, bold: true }, `[${icon}] ${pad(entry.type, 10)}`),
            e(Text, null, entry.text),
        );
    });

    return e(
        Box,
        {
            borderStyle: "round",
            borderColor: "gray",
            flexDirection: "column",
            paddingX: 1,
            height: VISIBLE_LOGS + 2,
        },
        e(Text, { bold: true, dimColor: true }, "EVENT LOG"),
        emptyRow,
        ...rowEls,
    );
}

function App() {
    useTick(1000);
    const { exit } = useApp();

    useInput((input, key) => {
        if (input === "q" || (key.ctrl && input === "c")) {
            exit();
            process.exit(0);
        }
    });

    const clients = state.clients;
    const total = clients.size;
    const executors = Array.from(clients.values()).filter(
        (c) => c.role === "executor",
    ).length;
    const plainClients = total - executors;
    const uptime = formatDuration(Date.now() - state.startedAt);

    return e(
        Box,
        { flexDirection: "column" },
        e(
            Gradient,
            { name: "passion" },
            e(BigText, { text: "Executor WebSocket Bridge", font: "tiny" }),
        ),
        e(
            Text,
            { dimColor: true },
            `listening on ws://localhost:${PORT}   |   uptime ${uptime}   |   press `,
            e(Text, { color: "white", bold: true }, "q"),
            " to quit",
        ),
        e(
            Box,
            { marginTop: 1 },
            e(StatBox, {
                label: "CONNECTED",
                value: total,
                color: "blueBright",
            }),
            e(StatBox, {
                label: "EXECUTORS",
                value: executors,
                color: "yellowBright",
            }),
            e(StatBox, {
                label: "CLIENTS",
                value: plainClients,
                color: "greenBright",
            }),
            e(StatBox, {
                label: "EXECUTES SENT",
                value: state.totalExecutes,
                color: "magentaBright",
            }),
        ),
        e(Box, { marginTop: 1 }, e(ConnectionsTable, { clients })),
        e(Box, { marginTop: 1 }, e(LogBox, { logs: state.logs })),
    );
}

render(e(App));
