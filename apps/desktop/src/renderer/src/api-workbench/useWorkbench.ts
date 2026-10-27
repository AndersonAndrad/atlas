import {
  emptyHttpRequestDefinition,
  type HttpCollection,
  type HttpExecutionResult,
  type HttpRequestDefinition,
  type ListHttpCollectionsInput,
} from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';

export type ResponseState =
  | { status: 'idle' }
  | { status: 'sending'; executionId: string }
  | { status: 'done'; result: HttpExecutionResult }
  | { status: 'failed'; code: string; message: string; details: string[] };

/** An open request (FR-1406). Secret values live only here, never in storage. */
export interface RequestTab {
  key: string;
  requestId: string | null;
  collectionId: string | null;
  folderId: string | null;
  name: string;
  definition: HttpRequestDefinition;
  /** What was last loaded or saved, to tell unsaved changes. */
  baseline: string;
  response: ResponseState;
}

// Definitions are replaced, never changed in place, so each one is serialized once.
const serialized = new WeakMap<HttpRequestDefinition, string>();

const fingerprint = (tab: Pick<RequestTab, 'name' | 'definition'>) => {
  let definition = serialized.get(tab.definition);
  if (definition === undefined) {
    definition = JSON.stringify(tab.definition);
    serialized.set(tab.definition, definition);
  }
  return `${tab.name}\u0000${definition}`;
};

export const isDirty = (tab: RequestTab) => fingerprint(tab) !== tab.baseline;

/** Tabs kept open at once; older responses are released by the Engine as well. */
const MAX_TABS = 20;

export interface DraftRequest {
  name: string;
  definition: HttpRequestDefinition;
}

function newTab(
  collectionId: string | null,
  folderId: string | null,
  draft?: DraftRequest,
): RequestTab {
  const tab = {
    key: crypto.randomUUID(),
    requestId: null,
    collectionId,
    folderId,
    name: draft?.name ?? 'New request',
    definition: draft?.definition ?? emptyHttpRequestDefinition(),
    response: { status: 'idle' } as const,
  };
  return { ...tab, baseline: fingerprint(tab) };
}

const releaseResponse = (response: ResponseState) => {
  if (response.status === 'done') void api().http.release(response.result.executionId);
  if (response.status === 'sending') void api().http.cancel(response.executionId);
};

/** Collections of the project in view and the open request tabs. */
export function useWorkbench(projectId: string | null) {
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [collections, setCollections] = useState<HttpCollection[] | null>(null);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RequestTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  });

  const reloadCollections = useCallback(async () => {
    const filter: ListHttpCollectionsInput =
      scope === 'all' ? { kind: 'all' } : { kind: 'project', projectId };
    try {
      setCollections(await unwrap(api().http.collections(filter)));
      setCollectionsError(null);
    } catch (caught) {
      setCollectionsError(errorMessage(caught));
    }
  }, [scope, projectId]);

  useEffect(() => {
    void (async () => reloadCollections())();
  }, [reloadCollections]);

  // Responses kept by the Engine go away with the view.
  useEffect(
    () => () => {
      for (const tab of tabsRef.current) releaseResponse(tab.response);
    },
    [],
  );

  const updateTab = useCallback((key: string, change: (tab: RequestTab) => RequestTab) => {
    setTabs((current) => current.map((tab) => (tab.key === key ? change(tab) : tab)));
  }, []);

  const addTab = useCallback((tab: RequestTab) => {
    setTabs((current) => {
      const next = [...current, tab];
      for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TABS))) {
        releaseResponse(dropped.response);
      }
      return next.slice(-MAX_TABS);
    });
    setActiveKey(tab.key);
  }, []);

  const newRequest = useCallback(
    (collectionId: string | null = null, folderId: string | null = null, draft?: DraftRequest) =>
      addTab(newTab(collectionId, folderId, draft)),
    [addTab],
  );

  const openRequest = useCallback(
    async (requestId: string) => {
      const open = tabsRef.current.find((tab) => tab.requestId === requestId);
      if (open) {
        setActiveKey(open.key);
        return;
      }
      const saved = await unwrap(api().http.request(requestId));
      const tab = {
        key: crypto.randomUUID(),
        requestId: saved.id,
        collectionId: saved.collectionId,
        folderId: saved.folderId,
        name: saved.name,
        definition: saved.definition,
        response: { status: 'idle' } as const,
      };
      addTab({ ...tab, baseline: fingerprint(tab) });
    },
    [addTab],
  );

  const closeTab = useCallback((key: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((candidate) => candidate.key === key);
    if (index === -1) return;
    releaseResponse(current[index]!.response);
    const next = current.filter((candidate) => candidate.key !== key);
    tabsRef.current = next;
    setTabs(next);
    setActiveKey((active) =>
      active !== key ? active : (next[Math.min(index, next.length - 1)]?.key ?? null),
    );
  }, []);

  /** Sends without saving (FR-1406); HTTP error statuses are responses (FR-1407). */
  const send = useCallback(
    async (key: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.key === key);
      if (!tab || tab.response.status === 'sending') return;
      releaseResponse(tab.response);
      const executionId = crypto.randomUUID();
      updateTab(key, (current) => ({ ...current, response: { status: 'sending', executionId } }));
      let response: ResponseState;
      try {
        const result = await unwrap(
          api().http.send({
            executionId,
            collectionId: tab.collectionId,
            requestId: tab.requestId,
            definition: tab.definition,
          }),
        );
        response = { status: 'done', result };
      } catch (caught) {
        response = {
          status: 'failed',
          code: caught instanceof ApiError ? caught.code : 'INTERNAL_ERROR',
          message: errorMessage(caught),
          details: caught instanceof ApiError ? caught.issues.map((issue) => issue.message) : [],
        };
      }
      // The tab may have been closed meanwhile.
      if (!tabsRef.current.some((candidate) => candidate.key === key)) {
        releaseResponse(response);
        return;
      }
      updateTab(key, (current) => ({ ...current, response }));
      setHistoryVersion((version) => version + 1);
    },
    [updateTab],
  );

  const cancel = useCallback((key: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.key === key);
    if (tab?.response.status === 'sending') void api().http.cancel(tab.response.executionId);
  }, []);

  /** Saves into the collection and folder given, or where the request already is. */
  const save = useCallback(
    async (
      key: string,
      target?: { collectionId: string; folderId: string | null; name: string },
    ) => {
      const tab = tabsRef.current.find((candidate) => candidate.key === key);
      if (!tab) return;
      const collectionId = target?.collectionId ?? tab.collectionId;
      if (collectionId === null) throw new Error('A collection is required.');
      const name = target?.name ?? tab.name;
      const saved = await unwrap(
        api().http.saveRequest({
          ...(tab.requestId !== null && !target ? { id: tab.requestId } : {}),
          collectionId,
          folderId: target ? target.folderId : tab.folderId,
          name,
          definition: tab.definition,
        }),
      );
      // The tab keeps secret values typed in this session; storage does not (PLAN-042 Q1).
      updateTab(key, (current) => ({
        ...current,
        requestId: saved.id,
        collectionId: saved.collectionId,
        folderId: saved.folderId,
        name: saved.name,
        // What was sent to storage; edits made while saving stay marked as unsaved.
        baseline: fingerprint({ name: saved.name, definition: tab.definition }),
      }));
      await reloadCollections();
    },
    [updateTab, reloadCollections],
  );

  /** A request or collection was removed elsewhere: its tabs become unsaved drafts. */
  const forgetSaved = useCallback((predicate: (tab: RequestTab) => boolean) => {
    setTabs((current) =>
      current.map((tab) =>
        predicate(tab) ? { ...tab, requestId: null, collectionId: null, folderId: null } : tab,
      ),
    );
  }, []);

  return {
    scope,
    setScope,
    collections,
    collectionsError,
    reloadCollections,
    tabs,
    activeKey,
    setActiveKey,
    activeTab: tabs.find((tab) => tab.key === activeKey) ?? null,
    newRequest,
    openRequest,
    updateTab,
    closeTab,
    send,
    cancel,
    save,
    forgetSaved,
    historyVersion,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
