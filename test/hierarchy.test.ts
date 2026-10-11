import * as assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';

import { AbcFile } from '../src';
import { assertAbcError, fixture } from './helpers';

describe('hierarchy', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(fixture('nested_hierarchy')); });
    after(() => file.close());

    it('lists every object depth-first', () => {
        assert.deepEqual(file.getObjects().map((obj) => obj.path), [
            '/root',
            '/root/child_a',
            '/root/child_a/grandchild',
            '/root/child_a/grandchild/quadShape',
            '/root/child_b',
        ]);
    });

    it('records names, types and parent/child relationships', () => {
        const root = file.getObject('/root')!;
        assert.equal(root.name, 'root');
        assert.equal(root.type, 'xform');
        assert.equal(root.parent, undefined);
        assert.deepEqual(root.children, ['/root/child_a', '/root/child_b']);

        const shape = file.getObject('/root/child_a/grandchild/quadShape')!;
        assert.equal(shape.type, 'mesh');
        assert.equal(shape.schema, 'AbcGeom_PolyMesh_v1');
        assert.equal(shape.parent, '/root/child_a/grandchild');
        assert.deepEqual(shape.children, []);
    });

    it('flags animated objects', () => {
        const childA = file.getObject('/root/child_a')!;
        assert.equal(childA.animated, true);
        assert.equal(childA.numSamples, 3);
        assert.equal(file.getObject('/root')!.animated, false);
        assert.equal(file.getObject('/root')!.numSamples, 1);
    });

    it('returns top-level objects and children', () => {
        assert.deepEqual(file.getChildren().map((obj) => obj.path), ['/root']);
        assert.deepEqual(file.getChildren('/').map((obj) => obj.path), ['/root']);
        assert.deepEqual(file.getChildren('/root').map((obj) => obj.name), ['child_a', 'child_b']);
        assert.deepEqual(file.getChildren('/root/child_b'), []);
    });

    it('returns null for unknown objects and throws for unknown parents', () => {
        assert.equal(file.getObject('/nope'), null);
        assert.equal(file.getObject('root'), null);
        assertAbcError(() => file.getChildren('/nope'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });

    it('traverses with depth and supports pruning', () => {
        const visited: string[] = [];
        file.traverse((obj, depth) => { visited.push(`${depth}:${obj.name}`); });
        assert.deepEqual(visited, ['0:root', '1:child_a', '2:grandchild', '3:quadShape', '1:child_b']);

        const pruned: string[] = [];
        file.traverse((obj) => {
            pruned.push(obj.name);
            return obj.name !== 'child_a';
        });
        assert.deepEqual(pruned, ['root', 'child_a', 'child_b']);
    });

    it('returns copies that cannot corrupt the cached hierarchy', () => {
        const obj = file.getObject('/root')!;
        obj.children.push('/bogus');
        obj.name = 'changed';
        assert.deepEqual(file.getObject('/root')!.children, ['/root/child_a', '/root/child_b']);
        assert.equal(file.getObject('/root')!.name, 'root');
    });
});

describe('object types', () => {
    it('classifies non-geometry schemas', () => {
        const file = AbcFile.open(fixture('unsupported_types'));
        const types = Object.fromEntries(file.getObjects().map((obj) => [obj.path, obj.type]));
        assert.deepEqual(types, {
            '/particles': 'points',
            '/curve': 'curves',
            '/camera': 'camera',
            '/group': 'unknown',
        });
        assert.equal(file.getObject('/group')!.schema, '');
        file.close();
    });
});
