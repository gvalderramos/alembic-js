const alembicJs = require('../build/alembic-js')

export interface AbcInfo {
    load(path: string): string;
}

export var AbcInfo: {
    new(path?: string): AbcInfo;
} = alembicJs.AbcInfo;
