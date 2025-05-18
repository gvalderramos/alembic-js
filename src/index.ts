import { AbcInfo } from "./bindings";

const abcInfo = new AbcInfo();
abcInfo.load("resource/Ancient_Kettle.abc")
    .then((res)=>{
        console.info(`${res}`)
        console.info(`AppName: ${abcInfo.appName()}`);
        console.info(`Version: ${abcInfo.libraryVersion()}`);
        console.info(`Version Str: ${abcInfo.libraryVersionString()}`);
        console.info(`Description: ${abcInfo.userDescription()}`);
        console.info(`When Written: ${abcInfo.whenWritten()}`);
    })
    .catch((err)=>{
        console.error(`Unable to read the alembic file, because ${err}`)
    });

