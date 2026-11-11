// This plugin owns its Remote service and registers its endpoints under /preview.
// The automatic-loader artifact remains empty so cached older artifacts can coexist during hot upgrades.
// strict codec 形状(typert-loader 要求 mode:'strict' + typeSymbol)
const sessionIdCodec = {
    mode: 'strict',
    typeSymbol: 'dsh-session-inplace-reset/types#SessionId',
    create: () => sessionIdCodec.schema,
    schema: { parse(value) { if (typeof value !== 'string' || !value.startsWith('session-'))
            throw new TypeError('sessionId must be a session id string'); return value; } },
};
const resultSchema = { parse: (v) => v };
const executeRequestCodec = {
    mode: 'strict',
    typeSymbol: 'dsh-session-inplace-reset/types#ExecuteRequest',
    create: () => executeRequestCodec.schema,
    schema: { parse(v) {
            const o = typeof v === 'object' && v !== null ? v : {};
            if (typeof o.sessionId !== 'string' || !o.sessionId.startsWith('session-'))
                throw new TypeError('request.sessionId required');
            return o;
        } },
};
export const ENDPOINTS = {
    package: '@local/dsh-session-inplace-reset',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
        {
            id: 'dsh-session-inplace-reset#sessionReset/sessionResetDryRun',
            service: 'sessionReset',
            namespace: 'sessionReset',
            method: 'sessionResetDryRun',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
            result: {
                mode: 'strict',
                typeSymbol: 'dsh-session-inplace-reset/types#DryRunValue',
                create: () => resultSchema,
                schema: resultSchema,
            },
            sourceLocation: { file: 'lib/typert.js', line: 1, column: 1 },
        },
        {
            id: 'dsh-session-inplace-reset#sessionReset/sessionResetExecute',
            service: 'sessionReset',
            namespace: 'sessionReset',
            method: 'sessionResetExecute',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'request', wire: 'request', source: 'json', codec: executeRequestCodec }],
            result: {
                mode: 'strict',
                typeSymbol: 'dsh-session-inplace-reset/types#ExecuteValue',
                create: () => resultSchema,
                schema: resultSchema,
            },
            sourceLocation: { file: 'lib/typert.js', line: 1, column: 1 },
        },
        {
            id: 'dsh-session-inplace-reset#sessionReset/sessionResetResume',
            service: 'sessionReset',
            namespace: 'sessionReset',
            method: 'sessionResetResume',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'request', wire: 'request', source: 'json', codec: executeRequestCodec }],
            result: {
                mode: 'strict',
                typeSymbol: 'dsh-session-inplace-reset/types#ResumeValue',
                create: () => resultSchema,
                schema: resultSchema,
            },
            sourceLocation: { file: 'lib/typert.js', line: 1, column: 1 },
        },
    ],
};
export const TYPERT = { ...ENDPOINTS, invocations: [] };
