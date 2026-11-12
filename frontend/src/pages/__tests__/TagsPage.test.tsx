import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import { apiErrorFrom } from '../../services/api/base';
import TagsPage from '../TagsPage';

vi.mock('react-hot-toast', () => {
  const toast = { success: vi.fn(), error: vi.fn() };
  return { default: toast, toast };
});

/**
 * Arriving with ?edit=<uuid> (the tag page's "Edit Tag") opens that tag's edit
 * dialog once the tags load, and drops the param so closing doesn't reopen it.
 */
const tagsState = vi.hoisted(() => ({ data: undefined as unknown[] | undefined }));
const updateTag = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const groceries = {
  id: 5,
  uuid: 'tag-5',
  name: 'Groceries',
  color: '#2563eb',
  icon: 'Tag',
  description: 'food',
  parent_id: null,
  level: 0,
  sort_order: 0,
  is_active: true,
  hierarchy_path: 'Groceries',
};

vi.mock('../../hooks/queries', async (importOriginal) => {
  const noop = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    ...(await importOriginal<typeof import('../../hooks/queries')>()),
    useTagsQuery: () => ({ data: tagsState.data, isLoading: tagsState.data === undefined }),
    useCreateTagMutation: noop,
    useUpdateTagMutation: () => ({ mutateAsync: updateTag.mutateAsync, isPending: false }),
    useDeleteTagMutation: noop,
    useUpdateTagReportRootMutation: noop,
  };
});

let location = '';
const LocationProbe = () => {
  const { search } = useLocation();
  useEffect(() => {
    location = search;
  }, [search]);
  return null;
};

const page = (route: string) => (
  <QueryClientProvider client={makeTestQueryClient()}>
    <Theme>
      <MemoryRouter initialEntries={[route]}>
        <TagsPage />
        <LocationProbe />
      </MemoryRouter>
    </Theme>
  </QueryClientProvider>
);

describe('TagsPage ?edit=', () => {
  beforeEach(() => {
    tagsState.data = undefined;
    location = '';
    sessionStorage.clear();
  });

  it("opens the tag's edit dialog once the tags load, and drops the param", async () => {
    const { rerender } = render(page('/tags?edit=tag-5&view=tree'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    tagsState.data = [groceries];
    rerender(page('/tags?edit=tag-5&view=tree'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Tag' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByDisplayValue('Groceries')).toBeInTheDocument();
    await waitFor(() => expect(location).toBe('?view=tree'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('leaves a param that names no tag alone', async () => {
    tagsState.data = [groceries];
    render(page('/tags?edit=nope'));
    await waitFor(() => expect(location).toBe('?edit=nope'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/**
 * Tags go four levels deep, levels 0 to 3: a tag at level 3 takes no sub-tag, and
 * isn't offered as a parent. The page offered tags down to level 4, which the server
 * refused.
 */
describe('TagsPage depth', () => {
  const at = (id: number, name: string, level: number) => ({
    ...groceries, id, uuid: `tag-${id}`, name, level, hierarchy_path: name,
  });

  beforeEach(() => {
    sessionStorage.clear();
    tagsState.data = [at(6, 'Third level', 2), at(7, 'Fourth level', 3)];
  });

  const actionsOf = async (name: string) => {
    const row = (await screen.findByText(name)).closest('[draggable]') as HTMLElement;
    return within(row).getByRole('button', { name: 'Tag actions' });
  };

  it('offers a sub-tag on a tag at level 2, not on one at level 3', async () => {
    render(page('/tags?view=tree'));

    await userEvent.click(await actionsOf('Third level'));
    expect(await screen.findByRole('menuitem', { name: /add sub-tag/i })).not.toHaveAttribute('data-disabled');
    await userEvent.keyboard('{Escape}');

    await userEvent.click(await actionsOf('Fourth level'));
    expect(await screen.findByRole('menuitem', { name: /add sub-tag/i })).toHaveAttribute('data-disabled');
  });

  it('offers no tag at level 3 as a parent to move to', async () => {
    // Radix Select uses pointer capture, which jsdom lacks.
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {} });
    tagsState.data = [...(tagsState.data ?? []), at(8, 'Loose', 0)];
    render(page('/tags?view=tree'));

    await userEvent.click(await actionsOf('Loose'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /move to/i }));
    const dialog = await screen.findByRole('dialog', { name: /move/i });
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Parent Tag' }));
    expect(await screen.findByRole('option', { name: 'Third level' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Fourth level' })).not.toBeInTheDocument();
  });
});

/**
 * A move the server refuses (a subtree past level 3, a report root under a parent;
 * the tags may have changed since the page loaded them) shows its reason, by drag and drop,
 * the Move dialog or the Edit dialog: the page said "Failed to move tag".
 */
describe('TagsPage refused move', () => {
  const at = (id: number, name: string, level: number, parentId: number | null = null) => ({
    ...groceries, id, uuid: `tag-${id}`, name, level, parent_id: parentId, hierarchy_path: name,
  });
  const reason = 'Cannot move tag: maximum hierarchy depth of 4 levels exceeded';

  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(toast.error).mockClear();
    updateTag.mutateAsync.mockReset();
    updateTag.mutateAsync.mockRejectedValue(
      apiErrorFrom(new Response(null, { status: 400 }), { error: 'Maximum depth exceeded', message: reason, code: 'BAD_REQUEST' })
    );
    tagsState.data = [at(6, 'Third level', 2), at(8, 'Loose', 0)];
  });

  const rowOf = async (name: string) => (await screen.findByText(name)).closest('[draggable]') as HTMLElement;

  it("shows the server's reason for a refused Move", async () => {
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {} });
    render(page('/tags?view=tree'));

    await userEvent.click(within(await rowOf('Loose')).getByRole('button', { name: 'Tag actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /move to/i }));
    const dialog = await screen.findByRole('dialog', { name: /move/i });
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Parent Tag' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Third level' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move Tag' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(updateTag.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tag-8', data: expect.objectContaining({ parent_id: 6 }) }));
  });

  it("shows the server's reason for a parent refused in the edit dialog", async () => {
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {} });
    render(page('/tags?edit=tag-8'));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Tag' });
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Parent Tag' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Third level' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(screen.getByRole('dialog', { name: 'Edit Tag' })).toBeInTheDocument();
  });

  it("shows the server's reason for a refused drag", async () => {
    render(page('/tags?view=tree'));
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };

    fireEvent.dragStart(await rowOf('Loose'), { dataTransfer });
    fireEvent.drop(await rowOf('Third level'), { dataTransfer });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason));
    expect(updateTag.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tag-8', data: expect.objectContaining({ parent_id: 6 }) }));
  });
});

/**
 * The Move and Edit dialogs offer only the parents the server takes: not the tag or
 * a tag below it, nor one where the tags below it would pass level 3, and none for a report
 * root, which stays at the top. They offered any tag above level 3 (the Edit dialog the
 * tag's own children too), which the server then refused.
 */
describe('TagsPage parents offered for a move', () => {
  const at = (id: number, name: string, level: number, parentId: number | null = null, isReportRoot = false) => ({
    ...groceries, id, uuid: `tag-${id}`, name, level, parent_id: parentId, hierarchy_path: name, is_report_root: isReportRoot,
  });

  beforeEach(() => {
    sessionStorage.clear();
    Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {} });
    tagsState.data = [
      at(10, 'Top', 0),
      at(11, 'Second', 1, 10),
      at(12, 'Third', 2, 11),
      at(13, 'Fourth', 3, 12),
      at(20, 'Subtree', 0),
      at(21, 'Subtree child', 1, 20),
      at(30, 'Namespace', 0, null, true),
    ];
  });

  const rowOf = async (name: string) => (await screen.findByText(name)).closest('[draggable]') as HTMLElement;
  const offered = async (dialog: HTMLElement) => {
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Parent Tag' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    await userEvent.keyboard('{Escape}');
    return options;
  };
  const moveDialogFor = async (name: string) => {
    await userEvent.click(within(await rowOf(name)).getByRole('button', { name: 'Tag actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /move to/i }));
    return screen.findByRole('dialog', { name: /move/i });
  };

  it('offers a tag with a tag below it only parents at level 1 or above, never its own', async () => {
    render(page('/tags?view=tree'));
    expect(await offered(await moveDialogFor('Subtree'))).toEqual(['None (Root Level)', 'Top', 'Second', 'Namespace']);
  });

  it('offers the same in the Edit dialog, without the tag below it', async () => {
    render(page('/tags?edit=tag-20'));
    expect(await offered(await screen.findByRole('dialog', { name: 'Edit Tag' }))).toEqual(['None (Root Level)', 'Top', 'Second', 'Namespace']);
  });

  it('offers a report root no parent', async () => {
    render(page('/tags?view=tree'));
    expect(await offered(await moveDialogFor('Namespace'))).toEqual(['None (Root Level)']);
  });

  // The top is a move too: the server refuses it when four levels of tags or more are below
  // the tag (an older install's). Such a tag is offered only where it is.
  it('offers no move to the top to a tag with four levels below it', async () => {
    tagsState.data = [
      ...(tagsState.data ?? []),
      at(40, 'Deep 1', 1, 10),
      at(41, 'Deep 2', 2, 40),
      at(42, 'Deep 3', 3, 41),
      at(43, 'Deep 4', 4, 42),
      at(44, 'Deep 5', 5, 43),
    ];
    sessionStorage.setItem('tags-expanded', JSON.stringify([10, 40]));
    render(page('/tags?view=tree'));
    expect(await offered(await moveDialogFor('Deep 1'))).toEqual(['Top']);
    await userEvent.keyboard('{Escape}');
    // With three below it, the top is offered.
    expect(await offered(await moveDialogFor('Deep 2'))).toEqual(['None (Root Level)', 'Deep 1']);
  });

  it('offers no move to the top in the Edit dialog either', async () => {
    tagsState.data = [...(tagsState.data ?? []), at(40, 'Deep 1', 1, 10), at(41, 'Deep 2', 2, 40), at(42, 'Deep 3', 3, 41), at(43, 'Deep 4', 4, 42), at(44, 'Deep 5', 5, 43)];
    render(page('/tags?edit=tag-40'));
    expect(await offered(await screen.findByRole('dialog', { name: 'Edit Tag' }))).toEqual(['Top']);
  });

  // An older install may hold a tag past level 3: it may stay where it is.
  it('keeps offering the parent a tag has, however deep', async () => {
    tagsState.data = [...(tagsState.data ?? []), at(14, 'Fifth', 4, 13)];
    render(page('/tags?edit=tag-14'));
    expect(await offered(await screen.findByRole('dialog', { name: 'Edit Tag' }))).toEqual([
      'None (Root Level)', 'Top', 'Second', 'Third', 'Fourth', 'Subtree', 'Subtree child', 'Namespace',
    ]);
  });
});
