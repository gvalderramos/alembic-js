const alembicJs = require('../build/alembic-js')

export interface AbcInfo {
    load(path: string): Promise<null>;
    appName(): string;
    libraryVersionString(): string;
    libraryVersion(): number;
    whenWritten(): string;
    userDescription(): string;
}

export var AbcInfo: {
    new(path?: string): AbcInfo;
} = alembicJs.AbcInfo;
