import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { definePluginSettings, OptionType } = Bedrock;

export const settings = definePluginSettings({
    visible: { type: OptionType.BOOLEAN, label: 'Show console', default: true },
    writeLogs: { type: OptionType.BOOLEAN, label: 'Write logs to file', default: false,
        description: 'Save logs to BedrockData/logs/latest.log and keep ten archived sessions.' },
    discordFileOutput: { type: OptionType.BOOLEAN, label: 'Include Discord logs in files', default: false,
        description: 'Save captured Discord JavaScript logs alongside Bedrock messages.' },
    discordOutput: { type: OptionType.BOOLEAN, label: 'Show Discord output', default: true,
        description: 'Include Discord logs alongside Bedrock messages. Some native libraries may bypass this filter.' }
});

export function start(ctx) {
    const native = require(`./native/${process.platform}-${process.arch}/console.node`);
    const apply = () => {
        ctx.logs.configureFile({ enabled: settings.store.writeLogs, discord: settings.store.discordFileOutput });
        native.filter(!settings.store.discordOutput);
        if (settings.store.visible) native.show();
        else native.hide();
    };
    ctx.cleanup(() => { native.filter(false); native.hide(); });
    ctx.cleanup(settings.subscribe(apply));
    ctx.cleanup(ctx.logs.subscribe(entry => {
        if (settings.store.visible && (entry.bedrock || settings.store.discordOutput)) native.write(entry.text + '\n');
    }));
    for (const stream of [process.stdout, process.stderr]) {
        ctx.patches.instead(stream, 'write', ([chunk, encoding, callback]) => {
            const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
            ctx.logs.publish({ level: stream === process.stderr ? 'error' : 'info', text: text.replace(/\n$/, ''), bedrock: false });
            const done = typeof encoding === 'function' ? encoding : callback;
            if (typeof done === 'function') process.nextTick(done);
            return true;
        });
    }
    apply();
}
