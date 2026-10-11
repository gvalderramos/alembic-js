import { AbcInfo } from '../src/bindings';
import { readFileSync } from 'fs';

async function main() {
    const abcInfo = new AbcInfo();
    
    // Load the file
    console.log("Loading ABC file...");
    const loadResult = await abcInfo.load("resource/Ancient_Kettle.abc");
    console.log(`Load result: ${loadResult}`);

    // Get metadata
    console.log("\nMetadata:");
    console.log(`App Name: ${abcInfo.appName()}`);
    console.log(`Library Version String: ${abcInfo.libraryVersionString()}`);
    console.log(`Library Version: ${abcInfo.libraryVersion()}`);
    console.log(`Write Time: ${abcInfo.whenWritten()}`);
    console.log(`User Description: ${abcInfo.userDescription()}`);

    // Get objects hierarchy
    console.log("\nObject Hierarchy:");
    const objects = await abcInfo.getObjects();
    objects.forEach(obj => {
        console.log(`- ${obj.name} (${obj.type})`);
        if (obj.children.length > 0) {
            obj.children.forEach(child => {
                console.log(`  - ${child.name} (${child.type})`);
            });
        }
    });

    // Get properties
    console.log("\nProperties:");
    const properties = await abcInfo.getProperties();
    properties.forEach(prop => {
        console.log(`- ${prop.name}: ${prop.type} (${prop.value})`);
    });
}

main().catch(e => console.error(e));
