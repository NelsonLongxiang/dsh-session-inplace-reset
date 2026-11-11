// Use the host's own SDK copy so the service binding and its lifetime belong to this plugin fiber.
export function mountResetRemote(ctx, load, methods) {
    const { TypertRemoteService } = load('@deepseek-ai/dsh-typert-protocol');
    class SessionResetRemote extends TypertRemoteService {
        constructor() { super(ctx, 'sessionReset'); Object.assign(this, methods); }
    }
    return new SessionResetRemote();
}
