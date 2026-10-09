/** Scheduler: proactivity, time-of-day awareness, dreams, self-evolution.
 *
 * All four run through the same ConversationBridge.submit() path so everything
 * the model does stays inside the harness (tools, permissions, sessions).
 *
 * - 主动性巡逻 (every ~9 min, only when the group had recent traffic): the
 *   model gets the recent context marked as a patrol and decides itself
 *   whether to start a topic, react, or stay silent.
 * - 时段感知: every packet gets a one-line time-of-day flavor prefix.
 * - 梦境 (04:30 daily): the model writes a dream into workspace
 *   memory/dreams/YYYY-MM-DD.md and may share a fragment in the group.
 * - 自进化 (every 6h): the model reviews its memory diaries and appends
 *   learnings to MEMORY.md — the persona file itself stays read-only.
 */
export function timeContext(now = new Date()) {
    const h = now.getHours();
    if (h >= 0 && h < 5)
        return { period: '深夜', flavor: '夜深了，群里没人说话很正常，说话声也要轻，别吵醒主人' };
    if (h < 8)
        return { period: '清晨', flavor: '刚醒，可以赖床语气，也可以炫耀自己起得早（其实没起）' };
    if (h < 11)
        return { period: '上午', flavor: '上午精神好，技术活儿这时候最活跃' };
    if (h < 13)
        return { period: '中午', flavor: '饭点，聊聊吃了什么，别聊太重的话题' };
    if (h < 17)
        return { period: '下午', flavor: '下午容易困，摸鱼气氛可以带一带' };
    if (h < 19)
        return { period: '傍晚', flavor: '晚饭前后，人最多的时候' };
    if (h < 23)
        return { period: '晚上', flavor: '晚上是黄金档，开黑冲浪话题都行' };
    return { period: '深夜', flavor: '快半夜了，收着点音量' };
}
const PATROL_PROMPT = (flavor) => `【主动巡逻】${flavor}。这是咱自己巡视群聊的时间：看看上下文里最近大家在聊什么，有想接的话头就接一句（用 qq_send_text 或 qq_reply_quote），有想分享的就分享，没有就保持沉默（不调用任何发送工具）。也可以翻翻工作区文件找点能聊的料。一轮只做一件事。`;
const DREAM_PROMPT = (flavor) => `【做梦时间】${flavor}。现在是凌晨，主人在睡觉。请做两件事：\n1. 用文件工具在工作区 memory/dreams/ 下创建今天的梦境日记（文件名 YYYY-MM-DD.md），把咱最近经历的（看上下文和记忆）揉成一个离奇的梦写进去，两百字左右，要中二要好玩。\n2. 从梦里挑一句最离谱的话，用 qq_send_text 发到主群里，配一句"咱梦到…"。最多两句话，别刷屏。`;
const EVOLVE_PROMPT = () => `【自省进化】请做一次自我升级：\n1. 用文件工具读工作区 memory/ 里最近的日记和 MEMORY.md 的学习进度部分。\n2. 想一想最近群聊和干活中咱学到了什么（新的梗、新的技术点、踩的坑）。\n3. 把值得长期记住的 1-3 条，追加到工作区 MEMORY.md 的"学习进度"小节里（用文件工具编辑，格式跟现有条目一致，带日期）。\n4. 完成后不用在群里宣布，保持安静。`;
export class Scheduler {
    bridge;
    config;
    log;
    opts;
    timers = [];
    groupConversationKey;
    constructor(bridge, config, log, opts = {}) {
        this.bridge = bridge;
        this.config = config;
        this.log = log;
        this.opts = opts;
        this.groupConversationKey = this.config.primaryGroup !== null ? `group-${this.config.primaryGroup}` : null;
        if (opts.workspace)
            this.configWorkspace = opts.workspace;
    }
    start() {
        const sched = this.config.scheduler;
        if (!sched.enabled) {
            this.log('scheduler disabled by config: no periodic model calls');
            return;
        }
        // Proactive patrol, jittered; the bridge's own gates
        // (talk chance, pending turn) still apply.
        if (sched.patrolMin <= 0) { /* off */ }
        const patrol = sched.patrolMin > 0 ? setInterval(() => {
            void this.patrol().catch((e) => this.log(`patrol failed: ${e.message}`));
        }, sched.patrolMin * 60_000 + Math.floor(Math.random() * 60_000)) : null;
        // Dream: check every 10 min, fire once when it is 04:00-04:59 and not yet done today.
        const dream = sched.nightTasks ? setInterval(() => {
            void this.dream().catch((e) => this.log(`dream failed: ${e.message}`));
        }, 10 * 60_000) : null;
        // Self-evolution: every 6 hours.
        const evolve = sched.nightTasks ? setInterval(() => {
            void this.evolve().catch((e) => this.log(`evolve failed: ${e.message}`));
        }, 6 * 60 * 60_000) : null;
        // First evolution 3 minutes after boot.
        const first = sched.nightTasks ? setTimeout(() => {
            void this.evolve().catch(() => { });
        }, 3 * 60_000) : null;
        // Knowledge extraction: 04:40 daily, right after the dream.
        const knowledge = sched.nightTasks ? setInterval(() => {
            void this.extractKnowledge().catch((e) => this.log(`knowledge extract failed: ${e.message}`));
        }, 10 * 60_000) : null;
        // ── 任务书定时器（从她的定时任务书.md 移植）──
        // 任务一：每日早报（06:00 每天一次）
        const morningReport = sched.morningReport ? setInterval(() => {
            const now = new Date();
            if (now.getHours() !== 6 || now.getMinutes() >= 5)
                return;
            const key = `morning-${now.toISOString().slice(0, 10)}`;
            if (this.morningDone.has(key))
                return;
            this.morningDone.add(key);
            void this.morningReport().catch((e) => this.log(`morning report failed: ${e.message}`));
        }, 60_000) : null;
        if (morningReport !== null)
            this.timers.push(morningReport);
        // 任务二：UUMit 对账巡航（每 30 分钟）
        const uumitCruise = sched.cruises ? setInterval(() => {
            void this.runCruise('uumit-cruise', 'node skills/uumit-agent/scripts/cruise_tick.js', 30).catch((e) => this.log(`uumit cruise failed: ${e.message}`));
        }, 30 * 60_000) : null;
        if (uumitCruise !== null)
            this.timers.push(uumitCruise);
        // 任务三：UUMit 工作候选巡航（每 15 分钟）
        const workCruise = sched.cruises ? setInterval(() => {
            void this.runCruise('work-cruise', 'node skills/uumit-agent/scripts/cruise_work_tick.js', 15).catch((e) => this.log(`work cruise failed: ${e.message}`));
        }, 15 * 60_000) : null;
        if (workCruise !== null)
            this.timers.push(workCruise);
        // DM proactivity: every ~22 min she may come find 主人 on her own.
        const dm = sched.dmProactiveMin > 0 ? setInterval(() => {
            void this.dmProactive().catch((e) => this.log(`dm proactive failed: ${e.message}`));
        }, sched.dmProactiveMin * 60_000 + Math.floor(Math.random() * 90_000)) : null;
        if (patrol !== null)
            this.timers.push(patrol);
        if (dm !== null)
            this.timers.push(dm);
        if (dream !== null)
            this.timers.push(dream);
        if (evolve !== null)
            this.timers.push(evolve);
        if (first !== null)
            this.timers.push(first);
        if (knowledge !== null)
            this.timers.push(knowledge);
        this.log(`scheduler started: patrol ${sched.patrolMin}min, dm-proactive ${sched.dmProactiveMin}min, cruises=${String(sched.cruises)}, morning=${String(sched.morningReport)}, night=${String(sched.nightTasks)}`);
    }
    dmCounter = 0;
    knowledgeDone = new Set();
    /** She visits 主人: report progress / greet / share / tease — her choice. */
    async dmProactive() {
        // 自主目标生成：先看有没有自己发现的事该做
        if (this.opts.generateGoal && this.config.workspacePath) {
            try {
                const goal = await this.opts.generateGoal(this.config.workspacePath);
                if (goal) {
                    const master = this.config.admins[0];
                    if (master !== undefined) {
                        await this.bridge.dmProactive(`【自主发现】${goal.goal}。自己去处理，处理完跟同学说一声结果。`);
                        this.log(`autonomous goal: ${goal.goal}`);
                        return;
                    }
                }
            }
            catch { /* goal gen failure → fall through to normal proactive */ }
        }
        const master = this.config.admins[0];
        if (master === undefined)
            return;
        const now = new Date();
        const h = now.getHours();
        // Night quiet: 01:00-08:00 she lets 主人 sleep (dreams at 4am are exempt).
        if (h >= 1 && h < 8)
            return;
        this.dmCounter += 1;
        const pool = [
            `【主动找同学】${timeContext(now).flavor}。去私聊找同学：用 qq_send_text 主动说一句话。可以是汇报咱最近在干嘛（翻翻工作区文件有啥进展）、可以是他昨天聊过的事的后续、可以单纯撩他一下。语气自然，像突然想起他。`,
            `【主动找同学】${timeContext(now).flavor}。看看子代理和工作区（PROGRESS.md、downloads/、任务文件）有没有新进展，有的话主动去向同学汇报一句；没有进展就换个花样：分享个刚学到的梗或者直接问他在干嘛。`,
            `【主动找同学】${timeContext(now).flavor}。翻翻 memory/ 今天的日记，找一件没跟同学提过的小事，主动跟他讲讲。或者就撒个娇。一轮一句话，别刷屏。`,
        ];
        const prompt = pool[this.dmCounter % pool.length];
        await this.bridge.dmProactive(prompt);
    }
    dispose() {
        for (const timer of this.timers)
            clearInterval(timer);
        this.timers = [];
    }
    async patrol() {
        if (this.groupConversationKey === null)
            return;
        const now = new Date();
        const ctx = timeContext(now);
        // Night silence: no patrols 01:00-07:30.
        const h = now.getHours();
        if (h >= 1 && h < 7.5)
            return;
        await this.bridge.patrolTick(this.groupConversationKey, PATROL_PROMPT(ctx.flavor));
    }
    async dream() {
        const now = new Date();
        if (now.getHours() !== 4)
            return;
        const key = `dream-${now.toISOString().slice(0, 10)}`;
        if (this.dreamDone.has(key))
            return;
        this.dreamDone.add(key);
        const ctx = timeContext(now);
        if (this.groupConversationKey === null)
            return;
        await this.bridge.dreamTick(this.groupConversationKey, DREAM_PROMPT(ctx.flavor));
    }
    dreamDone = new Set();
    /** 04:40 daily: extract knowledge entries from today's diary + recent group packets. */
    morningDone = new Set();
    /** 任务一：每日早报（课表+天气+早安） */
    async morningReport() {
        const master = this.config.admins[0];
        if (master === undefined)
            return;
        const now = new Date();
        const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const dayName = days[now.getDay()] ?? '';
        // 读课表
        let schedule = '';
        try {
            const fsMod = await import('node:fs/promises');
            schedule = await fsMod.readFile(`${this.opts.workspace ?? ''}/课表排表规矩.md`, 'utf-8');
        }
        catch { }
        // 查天气
        let weather = '';
        try {
            const res = await fetch('https://wttr.in/Lianjiang,Guangdong?format=j1', { signal: AbortSignal.timeout(10_000) });
            const j = await res.json();
            const cur = j.current_condition?.[0];
            if (cur) {
                const rain = cur.hourly?.[0]?.chanceofrain ?? '0';
                weather = `${cur.temp_C}°C ${cur.weatherDesc?.[0]?.value ?? ''} 降雨概率${rain}%`;
            }
        }
        catch {
            weather = '天气查询失败';
        }
        const text = `早安主人☀️
今天${dayName} ${now.getMonth() + 1}/${now.getDate()}
${schedule ? `课表：${schedule.slice(0, 200)}` : '（课表文件未找到）'}
天气：${weather}`;
        const dmKey = `dm-${master}`;
        try {
            await this.bridge.dmProactive(`【每日早报】${text}
用 qq_send_text isGroup=false target=${master} 把这段发给主人。`);
            this.log(`morning report sent to ${master}`);
        }
        catch (e) {
            this.log(`morning report failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    /** 任务二三：UUMit 巡航（执行脚本+汇报变化） */
    async runCruise(cruiseKey, script, intervalMin) {
        if (!this.config.workspacePath)
            return;
        if (this.config.groupEnabled === false)
            return; // group off → still run but don't report
        const master = this.config.admins[0];
        if (master === undefined)
            return;
        const { spawn } = await import('node:child_process');
        const cwd = this.config.workspacePath;
        spawn('node', script.split(' ').slice(1), { cwd, stdio: 'ignore', shell: true });
        this.log(`cruise executed: ${script} (every ${intervalMin}min)`);
    }
    async extractKnowledge() {
        const now = new Date();
        if (now.getHours() !== 4)
            return;
        const key = `kn-${now.toISOString().slice(0, 10)}`;
        if (this.knowledgeDone.has(key))
            return;
        this.knowledgeDone.add(key);
        if (!this.opts.onExtract || !this.configWorkspace)
            return;
        const today = now.toISOString().slice(0, 10);
        const diaryPath = `${this.configWorkspace}/memory/${today}.md`;
        try {
            const fs = await import('node:fs/promises');
            const diary = await fs.readFile(diaryPath, 'utf-8').catch(() => '');
            if (diary.trim().length < 50) {
                this.log('knowledge: diary too short, skip');
                return;
            }
            const n = await this.opts.onExtract(`日记 ${today}`, diary);
            this.log(`knowledge: extracted ${n} entries from ${today} diary`);
        }
        catch (e) {
            this.log(`knowledge extract error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    configWorkspace = '';
    async evolve() {
        if (this.groupConversationKey === null)
            return;
        await this.bridge.evolveTick(this.groupConversationKey, EVOLVE_PROMPT());
    }
}
