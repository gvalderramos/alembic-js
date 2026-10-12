/** Error codes raised by alembic-js. Native errors carry the same codes. */
export type AbcErrorCode =
    | 'ERR_ABC_INVALID_ARGUMENT'
    | 'ERR_ABC_FILE_NOT_FOUND'
    | 'ERR_ABC_INVALID_ARCHIVE'
    | 'ERR_ABC_NOT_LOADED'
    | 'ERR_ABC_OBJECT_NOT_FOUND'
    | 'ERR_ABC_UNSUPPORTED_TYPE'
    | 'ERR_ABC_MALFORMED_DATA'
    | 'ERR_ABC_READ_FAILED'
    | 'ERR_ABC_NATIVE_MODULE';

/** Structured error thrown by every alembic-js API. Check `code` to branch on the failure kind. */
export class AlembicError extends Error {
    readonly code: AbcErrorCode;
    /** Archive the error relates to, when known. */
    readonly file?: string;
    /** Alembic object path the error relates to, when known. */
    readonly objectPath?: string;

    constructor(
        code: AbcErrorCode,
        message: string,
        details: { file?: string; objectPath?: string; cause?: unknown } = {},
    ) {
        super(message);
        this.name = 'AlembicError';
        this.code = code;
        this.file = details.file;
        this.objectPath = details.objectPath;
        if (details.cause !== undefined) {
            Object.defineProperty(this, 'cause', { value: details.cause, enumerable: false });
        }
    }
}

export function isAlembicError(value: unknown): value is AlembicError {
    return value instanceof AlembicError;
}

/** Converts an error thrown by the native addon into an AlembicError. */
export function wrapNativeError(error: unknown, details: { file?: string; objectPath?: string } = {}): AlembicError {
    if (error instanceof AlembicError) {
        return error;
    }
    const native = error as { code?: unknown; message?: unknown };
    const code =
        typeof native?.code === 'string' && native.code.startsWith('ERR_ABC_')
            ? (native.code as AbcErrorCode)
            : 'ERR_ABC_READ_FAILED';
    const message = typeof native?.message === 'string' ? native.message : String(error);
    return new AlembicError(code, message, { ...details, cause: error });
}
