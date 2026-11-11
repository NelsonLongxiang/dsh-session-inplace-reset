var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { pathToFileURL } from 'node:url';
/** Both preview and execution derive their text from the same host projection, inside the caller's observation lease. */
export async function snapshotFromObservation(sessionId, observation, messageProjections, loader) {
    if (observation.header.id !== sessionId || !Number.isSafeInteger(observation.cursor))
        throw new Error('源观察不属于所选会话或游标不可校验');
    const { Session } = await import(__rewriteRelativeImportExtension(pathToFileURL(loader.resolve('@deepseek-ai/dsh-session')).href, true));
    const replay = Session.fromRestore(sessionId, observation.events, observation.header, observation.inheritedEventCount, 'shared-frozen', messageProjections);
    const messages = replay.surface.nodes.flatMap((seq) => {
        const message = replay.deriveEventMessage(observation.events[seq]);
        const text = message?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        return text ? [{ seq, role: message.role, sourceKind: message.source.kind, text }] : [];
    });
    return { sessionId, cursor: observation.cursor, messages };
}
