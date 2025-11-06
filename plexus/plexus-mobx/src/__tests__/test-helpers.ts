import * as Y from "yjs";
import {Plexus, PlexusModel, referenceSymbol, YJS_GLOBALS} from "@here.build/plexus";
import {nanoid} from "nanoid";

/**
 * Test implementation of Plexus for testing purposes.
 */
export class TestPlexus<Root extends PlexusModel> extends Plexus<Root> {
    protected createDefaultRoot(): Root {
        return null as any;
    }

    private availableDependencies: Map<string, () => Promise<Y.Doc>> = new Map();

    constructor(
        doc: Y.Doc,
        private readonly dependencies: Record<string, Y.Doc> = {}
    ) {
        super(doc);
    }

    async fetchDependency(dependencyId: string, dependencyVersion?: string): Promise<Y.Doc> {
        let depDoc = this.dependencies[dependencyId];

        if (!depDoc && this.availableDependencies.has(dependencyId)) {
            depDoc = await this.availableDependencies.get(dependencyId)!();
            this.dependencies[dependencyId] = depDoc;
        }

        if (!depDoc) {
            throw new Error(`Dependency "${dependencyId}" not found in test dependencies`);
        }

        const metadata = depDoc.getMap(YJS_GLOBALS.metadataMap);
        metadata.set(YJS_GLOBALS.metadataMapFields.documentId, dependencyId);

        return depDoc;
    }
}

/**
 * Initialize a document with test data and return an Plexus instance
 */
export async function initTestPlexus<Root extends PlexusModel>(
    rootEntity: Root,
    dependencies: Record<string, Y.Doc> = {},
    documentId?: string
): Promise<{ doc: Y.Doc; plexus: TestPlexus<Root>; root: Root }> {
    const doc = new Y.Doc();

    const plexus = new TestPlexus<Root>(doc, dependencies);

    // Force root UUID and materialize
    rootEntity._uuid = "root";
    rootEntity[referenceSymbol](doc);

    // Set up metadata
    const metadata = doc.getMap(YJS_GLOBALS.metadataMap);
    metadata.set(YJS_GLOBALS.metadataMapFields.documentId, documentId ?? nanoid());

    // Load the root through Plexus
    const root = await plexus.rootPromise;

    return {doc, plexus: plexus, root};
}
