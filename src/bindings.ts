export interface AbcInfo {
    load(path: string): Promise<string>;
    appName(): string;
    libraryVersionString(): string;
    libraryVersion(): number;
    whenWritten(): string;
    userDescription(): string;
    getObjects(): Promise<Object[]>;
    getProperties(): Promise<Object[]>;
}

export var AbcInfo: {
    new(): AbcInfo;
} = require('../build/alembic-js').AbcInfo;
