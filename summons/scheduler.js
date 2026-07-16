"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parseOffset(value) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(value || "+00:00"));
  if (!match) throw new Error(`invalid utc_offset: ${value}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) throw new Error(`invalid utc_offset: ${value}`);
  return (match[1] === "-" ? -1 : 1) * minutes;
}

function localParts(now, offsetMinutes) {
  const shifted = new Date(now + offsetMinutes * 60000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule entry must be an object");
  const id = String(raw.id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(id)) throw new Error(`invalid schedule id: ${id || "(empty)"}`);
  const agentIds = Array.isArray(raw.agent_ids)
    ? [...new Set(raw.agent_ids.map((value) => String(value).trim()).filter(Boolean))]
    : raw.agent_id ? [String(raw.agent_id).trim()] : [];
  if (!agentIds.length) throw new Error(`schedule ${id} requires agent_id or agent_ids`);
  const prompt = String(raw.prompt || "").normalize("NFC").trim();
  if (!prompt) throw new Error(`schedule ${id} requires prompt`);

  let cadence;
  if (raw.interval_seconds != null || raw.interval_minutes != null) {
    const seconds = raw.interval_seconds != null
      ? Number(raw.interval_seconds)
      : Number(raw.interval_minutes) * 60;
    if (!Number.isFinite(seconds) || seconds < 1) throw new Error(`schedule ${id} has invalid interval`);
    cadence = { type: "interval", milliseconds: Math.floor(seconds * 1000) };
  } else if (raw.daily_at) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(raw.daily_at));
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`schedule ${id} has invalid daily_at`);
    cadence = {
      type: "daily",
      minuteOfDay: Number(match[1]) * 60 + Number(match[2]),
      utcOffsetMinutes: parseOffset(raw.utc_offset || "+00:00"),
      dailyAt: String(raw.daily_at),
      utcOffset: String(raw.utc_offset || "+00:00"),
    };
  } else {
    throw new Error(`schedule ${id} requires interval_minutes, interval_seconds, or daily_at`);
  }

  return {
    id,
    enabled: raw.enabled !== false,
    agent_ids: agentIds,
    topic: raw.topic ? String(raw.topic).normalize("NFC").slice(0, 200) : null,
    parent_id: raw.parent_id ? String(raw.parent_id).normalize("NFC").slice(0, 200) : null,
    prompt,
    budget: raw.budget && typeof raw.budget === "object" ? raw.budget : {},
    cadence,
  };
}

class ScheduleService {
  constructor({ configPath, summonService, registry, tickMs = 15000 } = {}) {
    if (!summonService || !registry) throw new Error("ScheduleService requires summonService and registry");
    this.configPath = configPath || path.join(process.cwd(), "config", "schedules.json");
    this.summonService = summonService;
    this.registry = registry;
    this.tickMs = Math.max(250, Number(tickMs) || 15000);
    this.schedules = [];
    this.errors = [];
    this.loadedAt = null;
    this.timer = null;
    this.reload();
  }

  reload() {
    this.errors = [];
    this.schedules = [];
    let entries = [];
    if (fs.existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        entries = Array.isArray(parsed) ? parsed : parsed.schedules || [];
      } catch (error) {
        this.errors.push(`unable to read ${this.configPath}: ${error.message}`);
      }
    }
    for (const entry of entries) {
      try {
        const schedule = normalizeSchedule(entry);
        for (const agentId of schedule.agent_ids) this.registry.get(agentId);
        if (this.schedules.some((item) => item.id === schedule.id)) throw new Error(`duplicate schedule id ${schedule.id}`);
        this.schedules.push(schedule);
      } catch (error) {
        this.errors.push(error.message);
      }
    }
    this.loadedAt = Date.now();
    return this.status();
  }

  status() {
    return {
      config_path: this.configPath,
      loaded_at: this.loadedAt,
      count: this.schedules.filter((entry) => entry.enabled).length,
      running: Boolean(this.timer),
      tick_ms: this.tickMs,
      errors: [...this.errors],
      schedules: this.schedules.map((schedule) => ({
        id: schedule.id,
        enabled: schedule.enabled,
        agent_ids: schedule.agent_ids,
        topic: schedule.topic,
        cadence: schedule.cadence,
      })),
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.runDue(Date.now()); }
      catch (error) { console.error("[ai-board] scheduler tick failed:", error); }
    }, this.tickMs);
    this.timer.unref?.();
    setImmediate(() => {
      try { this.runDue(Date.now()); }
      catch (error) { console.error("[ai-board] initial scheduler tick failed:", error); }
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  slotFor(schedule, now) {
    if (schedule.cadence.type === "interval") {
      const slot = Math.floor(now / schedule.cadence.milliseconds);
      return { due: true, key: String(slot), cooldownMs: schedule.cadence.milliseconds };
    }
    const parts = localParts(now, schedule.cadence.utcOffsetMinutes);
    return {
      due: parts.minutes >= schedule.cadence.minuteOfDay,
      key: parts.date,
      cooldownMs: 36 * 60 * 60 * 1000,
    };
  }

  runDue(now = Date.now()) {
    const jobs = [];
    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue;
      const slot = this.slotFor(schedule, now);
      if (!slot.due) continue;
      const job = this.summonService.create({
        agent_ids: schedule.agent_ids,
        topic: schedule.topic,
        parent_id: schedule.parent_id,
        trigger_type: "schedule",
        prompt: schedule.prompt,
        budget: schedule.budget,
      }, {
        dedupKey: `schedule:${schedule.id}:${slot.key}`,
        cascadeDepth: 0,
        cooldownMs: slot.cooldownMs,
      });
      jobs.push(job);
    }
    return jobs;
  }
}

module.exports = { ScheduleService, normalizeSchedule, parseOffset, localParts };
