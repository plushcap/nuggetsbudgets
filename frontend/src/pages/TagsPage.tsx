import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card, Flex, Text, Button, Box, Dialog, TextField, Select, Checkbox, RadioGroup, DropdownMenu, IconButton, Badge } from '@radix-ui/themes';
import {
  Tag as TagIcon,
  Plus,
  Edit,
  Trash2,
  GripVertical,
  ChevronRight,
  ChevronDown,
  MoreVertical,
  Search,
  Eye,
  EyeOff,
  Move,
  CornerDownRight
} from 'lucide-react';
import { type Tag } from '../services/api/types';
import { TAG_DEEPEST_LEVEL, tagWriteSchema } from '@nuggets/shared';
import TagFormFields, { NO_PARENT } from '../components/forms/TagFormFields';
import { useFormReset } from '../hooks/useFormReset';
import { createDefaultTagForm, type TagFormData } from '../types/forms';
import {
  useTagsQuery,
  useCreateTagMutation,
  useUpdateTagMutation,
  useDeleteTagMutation,
  useUpdateTagReportRootMutation,
} from '../hooks/queries';
import { getIconByName } from '../utils/iconCatalog';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import toast from 'react-hot-toast';
import { logger } from '../utils/logger';
import { apiErrorMessage, errorMessage, errorStatus } from '../utils/errors';
import { EMPTY_LIST } from '../utils/emptyList';
import { mayMoveToTop, tagMoveTargets } from '../utils/tagMoveTargets';
import { readStoredJson, writeStoredJson } from '../utils/storage';
import { TAG_REPORT_FLOW_MEASURES, TAG_REPORT_FLOW_MEASURE_LABELS, type TagReportFlowMeasure } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import PageContainer from '../components/PageContainer';

/** The tag report's flow measures, recommended first, and what each sums. */
const FLOW_MEASURE_ORDER = ['effective', 'actual', 'allocated'] as const satisfies readonly TagReportFlowMeasure[];
const FLOW_MEASURE_HELP: Record<TagReportFlowMeasure, string> = {
  effective: 'Transactions for income/non-rollover, allocations for envelopes & rollover items.',
  actual: 'Always sum transactions. Misses internal allocation moves.',
  allocated: 'Always sum budget allocations. Income items typically show zero.',
};

interface TagTreeNode extends Tag {
  children: TagTreeNode[];
  isExpanded: boolean;
}

/**
 * The tag dialogs' check: POST /api/tags' and PUT /api/tags/:uuid's own schema. Raw: the
 * values go as typed (the server trims the name), so they are the form's own.
 */
const tagFormResolver = zodResolver(tagWriteSchema, undefined, { raw: true }) as unknown as Resolver<TagFormData>;

/** A tag's form values, for its Edit dialog. */
const tagFormFrom = (tag: Tag): TagFormData => ({
  name: tag.name,
  color: tag.color ?? '',
  icon: tag.icon ?? '',
  description: tag.description || '',
  parent_id: tag.parent_id,
  is_active: tag.is_active ?? true,
  is_report_root: tag.is_report_root ?? false,
  report_flow_measure: tag.report_flow_measure ?? 'effective',
});

const TagsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirmAsync, dialogProps } = useConfirmation();
  
  const { data: tags = EMPTY_LIST, isLoading: loading } = useTagsQuery();
  const createTagMutation = useCreateTagMutation();
  const updateTagMutation = useUpdateTagMutation();
  const deleteTagMutation = useDeleteTagMutation();
  const updateTagReportRootMutation = useUpdateTagReportRootMutation();
  // Expanded node ids (persisted to sessionStorage); drives each node's isExpanded.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => {
    return new Set<number>(readStoredJson<number[]>('session', 'tags-expanded', []));
  });
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [draggedTag, setDraggedTag] = useState<TagTreeNode | null>(null);
  const [dragOverTag, setDragOverTag] = useState<number | null>(null);

  // Search/filter for the tag tree
  const [searchQuery, setSearchQuery] = useState('');

  // Touch-friendly "Move to…" dialog (replaces drag-and-drop on mobile)
  const [movingTag, setMovingTag] = useState<TagTreeNode | null>(null);
  const [moveTargetId, setMoveTargetId] = useState<string>(NO_PARENT);

  // The Add and Edit dialogs' form (react-hook-form, checked with tagWriteSchema
  // and sent as typed: the server trims the name). One dialog is open at a time; each starts
  // from its tag, or from a new one (under the parent of "Add sub-tag").
  const [addParentId, setAddParentId] = useState<number | null>(null);
  // Arriving with ?edit=<uuid> (e.g. from the tag detail page's "Edit Tag" button) opens that
  // tag's Edit dialog: the form starts from it when its tags are there on the first render.
  const editParam = searchParams.get('edit');
  const tagFromUrl = editParam && !isEditDialogOpen ? tags.find(t => t.uuid === editParam) : undefined;
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<TagFormData>({
    defaultValues: tagFromUrl ? tagFormFrom(tagFromUrl) : createDefaultTagForm(),
    resolver: tagFormResolver,
  });
  useFormReset(
    reset,
    isEditDialogOpen && editingTag ? tagFormFrom(editingTag) : createDefaultTagForm(addParentId),
    [isAddDialogOpen, isEditDialogOpen, editingTag, addParentId],
  );
  const [parentId, isReportRoot] = useWatch({ control, name: ['parent_id', 'is_report_root'] });

  // Persist expanded state so it survives navigation/refresh.
  useEffect(() => {
    writeStoredJson('session', 'tags-expanded', Array.from(expandedIds));
  }, [expandedIds]);

  // Tag tree derived from the flat list + expanded state. Memoized so it is only
  // rebuilt/re-sorted when the tags or the expansion change — not every render.
  const tagTree = useMemo<TagTreeNode[]>(() => {
    if (!Array.isArray(tags)) {
      logger.error({ tags }, 'Tags is not an array');
      return [];
    }

    const tagMap = new Map<number, TagTreeNode>();
    tags.forEach(tag => {
      tagMap.set(tag.id, { ...tag, children: [], isExpanded: expandedIds.has(tag.id) });
    });

    const roots: TagTreeNode[] = [];
    tagMap.forEach(tag => {
      if (tag.parent_id === null) {
        roots.push(tag);
      } else {
        const parent = tagMap.get(tag.parent_id);
        if (parent) parent.children.push(tag);
      }
    });

    const sortTags = (nodes: TagTreeNode[]) => {
      nodes.sort((a, b) => {
        if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
        return a.name.localeCompare(b.name);
      });
      nodes.forEach(node => sortTags(node.children));
    };

    sortTags(roots);
    return roots;
  }, [tags, expandedIds]);

  // The ?edit= param is cleared once its dialog is open, so it doesn't reopen after the
  // dialog is closed.
  useEffect(() => {
    if (!editParam || !isEditDialogOpen) return;
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [editParam, isEditDialogOpen, searchParams, setSearchParams]);

  const toggleExpand = (tagId: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  // A name the schema refuses shows beside the field, which is focused; nothing is sent.
  const handleAddTag = async (form: TagFormData) => {
    try {
      await createTagMutation.mutateAsync(form);
      toast.success('Tag created successfully');
      setIsAddDialogOpen(false);
    } catch (err) {
      logger.error({ err }, 'Failed to create tag');
      toast.error('Failed to create tag');
    }
  };

  const handleEditTag = async (form: TagFormData) => {
    if (!editingTag) return;

    try {
      // Core attributes go through the existing PUT
      const { is_report_root, report_flow_measure, ...corePayload } = form;
      try {
        await updateTagMutation.mutateAsync({ uuid: editingTag.uuid, data: corePayload });
      } catch (putErr) {
        // Surface namespace conflicts with the server's message.
        if (errorStatus(putErr) === 409) {
          toast.error(errorMessage(putErr, 'Move would create a namespace conflict'));
          return;
        }
        throw putErr;
      }

      // Namespace flag only applies to level-0 tags. Send it as a follow-up
      // so we don't break the contract of the main PUT endpoint.
      const wasReportRoot = editingTag.is_report_root === true;
      const measureChanged = (editingTag.report_flow_measure || 'effective') !== report_flow_measure;
      const isLevelZero = form.parent_id === null && editingTag.parent_id === null;
      if (isLevelZero && (is_report_root !== wasReportRoot || (is_report_root && measureChanged))) {
        try {
          await updateTagReportRootMutation.mutateAsync({ uuid: editingTag.uuid, data: {
            is_report_root,
            ...(is_report_root ? { report_flow_measure } : {})
          } });
        } catch (nsErr) {
          logger.error({ err: nsErr, tagUuid: editingTag.uuid }, 'Failed to update tag namespace flag');
          toast.error('Tag updated, but namespace settings failed to save');
        }
      }

      toast.success('Tag updated successfully');
      setIsEditDialogOpen(false);
      setEditingTag(null);
    } catch (err) {
      logger.error({ err, tagUuid: editingTag.uuid }, 'Failed to update tag');
      // A parent the server refuses (too deep, a report root's) says why.
      toast.error(apiErrorMessage(err, 'Failed to update tag'));
    }
  };

  const handleDeleteTag = async (tag: Tag) => {
    const confirmed = await confirmAsync({
      title: 'Delete Tag',
      message: `Are you sure you want to delete "${tag.name}"? This action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete'
    });

    if (!confirmed) return;

    try {
      await deleteTagMutation.mutateAsync(tag.uuid);
      toast.success('Tag deleted successfully');
    } catch (err) {
      logger.error({ err, tagUuid: tag.uuid }, 'Failed to delete tag');
      toast.error('Failed to delete tag');
    }
  };

  // The form starts from the tag as the dialog opens (useFormReset, above).
  const openEditDialog = (tag: Tag) => {
    setEditingTag(tag);
    setIsEditDialogOpen(true);
  };

  /** Opens the Add dialog for a new tag, under `parentId` ("Add sub-tag") or at the top. */
  const openAddDialog = (parentId: number | null) => {
    setAddParentId(parentId);
    setIsAddDialogOpen(true);
  };

  // Open the dialog for ?edit= once its tag has loaded (adjusted while rendering).
  if (tagFromUrl) {
    openEditDialog(tagFromUrl);
  }

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, tag: TagTreeNode) => {
    setDraggedTag(tag);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.currentTarget.innerHTML);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDraggedTag(null);
    setDragOverTag(null);
  };

  const handleDragOver = (e: React.DragEvent, tag: TagTreeNode) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTag(tag.id);
  };

  const handleDragLeave = () => {
    setDragOverTag(null);
  };

  const handleDrop = async (e: React.DragEvent, targetTag: TagTreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedTag) return;

    // Prevent dropping on itself
    if (targetTag && draggedTag.id === targetTag.id) {
      setDragOverTag(null);
      return;
    }

    // Prevent dropping on own descendants
    if (targetTag && isDescendant(draggedTag, targetTag)) {
      toast.error('Cannot move tag to its own descendant');
      setDragOverTag(null);
      return;
    }

    await moveTagToParent(draggedTag, targetTag ? targetTag.id : null);
    setDragOverTag(null);
  };

  // Shared move logic used by both drag-and-drop (desktop) and the
  // "Move to…" dialog (touch-friendly).
  const moveTagToParent = async (tag: TagTreeNode, newParentId: number | null) => {
    try {
      await updateTagMutation.mutateAsync({ uuid: tag.uuid, data: { ...tag, parent_id: newParentId } });
      toast.success('Tag moved successfully');
    } catch (err) {
      logger.error({ err, tagUuid: tag.uuid, newParentId }, 'Failed to move tag');
      // The server's reason: a subtree that would go too deep, a report root.
      toast.error(apiErrorMessage(err, 'Failed to move tag'));
    }
  };

  const openMoveDialog = (tag: TagTreeNode) => {
    setMovingTag(tag);
    setMoveTargetId(tag.parent_id ? String(tag.parent_id) : NO_PARENT);
  };

  const confirmMove = async () => {
    if (!movingTag) return;
    const newParentId = moveTargetId === NO_PARENT ? null : parseInt(moveTargetId);
    await moveTagToParent(movingTag, newParentId);
    setMovingTag(null);
  };

  // Open the Add dialog pre-seeded with this tag as the parent.
  const openAddSubTag = (tag: TagTreeNode) => openAddDialog(tag.id);

  const toggleActive = async (tag: TagTreeNode) => {
    try {
      await updateTagMutation.mutateAsync({ uuid: tag.uuid, data: { ...tag, is_active: !tag.is_active } });
      toast.success(tag.is_active ? 'Tag deactivated' : 'Tag activated');
    } catch (err) {
      logger.error({ err, tagUuid: tag.uuid }, 'Failed to update tag');
      toast.error('Failed to update tag');
    }
  };

  // Filter the tree by name, keeping ancestors of any match so the hierarchy
  // stays visible. Returns the (possibly pruned) tree.
  const filterTree = (nodes: TagTreeNode[], query: string): TagTreeNode[] => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    const prune = (node: TagTreeNode): TagTreeNode | null => {
      const children = node.children
        .map(prune)
        .filter((c): c is TagTreeNode => c !== null);
      if (node.name.toLowerCase().includes(q) || children.length > 0) {
        return { ...node, children };
      }
      return null;
    };
    return nodes.map(prune).filter((n): n is TagTreeNode => n !== null);
  };

  const isDescendant = (parent: TagTreeNode, potentialChild: TagTreeNode): boolean => {
    if (parent.children.some(child => child.id === potentialChild.id)) {
      return true;
    }
    return parent.children.some(child => isDescendant(child, potentialChild));
  };

  const renderTagNode = (tag: TagTreeNode, depth: number = 0) => {
    const hasChildren = tag.children.length > 0;
    const isBeingDraggedOver = dragOverTag === tag.id;
    // While searching, force everything open so matches deep in the tree show.
    const isSearching = searchQuery.trim().length > 0;
    const expanded = isSearching || tag.isExpanded;
    const iconData = tag.icon ? getIconByName(tag.icon) : null;
    const IconComponent = iconData?.component;
    const count = tag.transaction_count || 0;

    return (
      <Box
        key={tag.id}
        {...(depth > 0 ? { ml: '3' as const, pl: '1' as const } : {})}
        className={depth > 0 ? 'border-l border-[var(--gray-5)]' : ''}
      >
        <Flex
          align="center"
          p="2"
          draggable
          onDragStart={(e) => handleDragStart(e, tag)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, tag)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, tag)}
          className={`
            group gap-1.5 sm:gap-2 rounded-[var(--radius-4)]
            border-2 transition-all md:cursor-move
            ${isBeingDraggedOver
              ? 'border-[var(--accent-8)] bg-[var(--accent-3)]'
              : 'border-transparent row-hover'
            }
          `}
        >
          {/* Drag Handle (desktop only — drag-and-drop doesn't work on touch) */}
          <GripVertical size={16} className="hidden md:block shrink-0 text-[var(--gray-11)] opacity-0 group-hover:opacity-100 transition-opacity" />

          {/* Expand/Collapse */}
          {hasChildren ? (
            <IconButton
              variant="ghost"
              color="gray"
              size="2"
              onClick={() => toggleExpand(tag.id)}
              disabled={isSearching}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              className="shrink-0"
            >
              {expanded ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </IconButton>
          ) : (
            <Box width="28px" flexShrink="0" />
          )}

          {/* Tag icon + name + count (tap to open the tag) */}
          <Button
            variant="ghost"
            color="gray"
            className="flex-1 min-w-0 justify-start text-left"
            onClick={() => navigate(`/tags/${tag.uuid}`)}
          >
            <Flex align="center" gap="2" minWidth="0px" width="100%">
              {IconComponent && (
                <IconComponent size={20} className="shrink-0" style={{ /* lint:guard colour: the tag's own colour */ color: tag.color || 'var(--accent-11)' }} />
              )}
              <Box minWidth="0px">
                <Flex align="center" gap="2">
                  <Text size="3" weight="medium" truncate color={tag.is_active ? undefined : 'gray'}>
                    {tag.name}
                  </Text>
                  {!tag.is_active && (
                    <Badge color="gray" variant="soft" size="1" className="shrink-0">
                      Inactive
                    </Badge>
                  )}
                </Flex>
                <Text as="div" size="1" color="gray">
                  {count} {count === 1 ? 'transaction' : 'transactions'}
                </Text>
              </Box>
            </Flex>
          </Button>

          {/* Actions overflow menu — single touch-friendly target */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton
                variant="ghost"
                color="gray"
                size="2"
                className="shrink-0"
                aria-label="Tag actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical size={16} />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={() => navigate(`/tags/${tag.uuid}`)}>
                <Eye size={16} /> View
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => openEditDialog(tag)}>
                <Edit size={16} /> Edit
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => openAddSubTag(tag)} disabled={tag.level >= TAG_DEEPEST_LEVEL}>
                <CornerDownRight size={16} /> Add sub-tag
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => openMoveDialog(tag)}>
                <Move size={16} /> Move to…
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => toggleActive(tag)}>
                {tag.is_active ? <EyeOff size={16} /> : <Eye size={16} />}
                {tag.is_active ? 'Deactivate' : 'Activate'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                color="red"
                disabled={hasChildren}
                onSelect={() => handleDeleteTag(tag)}
              >
                <Trash2 size={16} /> Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>

        {/* Children */}
        {hasChildren && expanded && (
          <Box>
            {tag.children.map(child => renderTagNode(child, depth + 1))}
          </Box>
        )}
      </Box>
    );
  };

  const isSearching = searchQuery.trim().length > 0;
  const displayTree = useMemo(() => filterTree(tagTree, searchQuery), [tagTree, searchQuery]);

  return (
    <PageContainer>
      <PageHeader
        title="Tags"
        subtitle={
          <Box as="span" className="hidden sm:block">
            Organize and categorize your transactions with hierarchical tags
          </Box>
        }
        actions={
          <Button onClick={() => openAddDialog(null)} className="shrink-0">
            <Plus size={16} className="mr-2" />
            <Box as="span" className="hidden sm:inline">Add Tag</Box>
            <span className="sm:hidden">Add</span>
          </Button>
        }
      />
      <Flex direction="column" gap="4">
        {/* Search */}
        {!loading && tagTree.length > 0 && (
          <TextField.Root
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search tags"
            placeholder="Search tags"
            variant="surface"
            size="3"
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </TextField.Root>
        )}

        {/* Tag Tree */}
        <Card>
          {loading ? (
            <PageLoader label="Loading tags…" />
          ) : tagTree.length === 0 ? (
            <Flex direction="column" align="center" gap="2" p="6" className="text-center">
              <TagIcon size={48} className="mb-2 text-[var(--gray-11)]" />
              <Text size="3" weight="medium" color="gray">
                No tags yet
              </Text>
              <Text size="2" color="gray">
                Create your first tag to start organizing transactions
              </Text>
            </Flex>
          ) : isSearching && displayTree.length === 0 ? (
            <Box p="6" className="text-center">
              <Text size="2" color="gray">
                No tags match “{searchQuery.trim()}”
              </Text>
            </Box>
          ) : (
            <Box className="p-2 sm:p-4">
              {/* Drop Zone for Root Level — desktop drag-and-drop only.
                  On touch, use a tag's "Move to…" action instead. */}
              <Box
                display={{ initial: 'none', sm: 'block' }}
                mb="4"
                p="4"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverTag(-1); // Special ID for root
                }}
                onDragLeave={() => setDragOverTag(null)}
                onDrop={(e) => handleDrop(e, null)}
                className={`
                  border-2 border-dashed rounded-[var(--radius-4)] text-center transition-colors
                  ${dragOverTag === -1
                    ? 'border-[var(--accent-8)] bg-[var(--accent-3)]'
                    : 'border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                  }
                `}
              >
                <Text size="2" color="gray">
                  Drop here to move to root level
                </Text>
              </Box>

              {displayTree.map(tag => renderTagNode(tag))}
            </Box>
          )}
        </Card>
      </Flex>

      {/* Add Tag Dialog */}
      <Dialog.Root open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <Dialog.Content maxWidth="500px">
          <Dialog.Title>Add New Tag</Dialog.Title>
          <form noValidate onSubmit={handleSubmit(handleAddTag)}>
            <TagFormFields
              idPrefix="add-tag"
              control={control}
              register={register}
              errors={errors}
              // Tags go 4 levels deep: none below the deepest
              parents={tags.filter(t => t.level < TAG_DEEPEST_LEVEL)}
              offerTop
            />

            <Flex gap="3" mt="4" justify="end">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
              <Button type="submit">Create Tag</Button>
            </Flex>
          </form>
        </Dialog.Content>
      </Dialog.Root>

      {/* Edit Tag Dialog */}
      <Dialog.Root open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <Dialog.Content maxWidth="500px">
          <Dialog.Title>Edit Tag</Dialog.Title>
          <form noValidate onSubmit={handleSubmit(handleEditTag)}>
            <TagFormFields
              idPrefix="edit-tag"
              control={control}
              register={register}
              errors={errors}
              // The top and the parents the server takes for this tag: not itself or a
              // tag below it, none past the deepest level with the tags below it
              parents={editingTag ? tagMoveTargets(tags, editingTag.id) : tags.filter(t => t.level < TAG_DEEPEST_LEVEL)}
              offerTop={!editingTag || mayMoveToTop(tags, editingTag.id)}
            >
              {/* Report-namespace controls — only meaningful on level-0 tags */}
              {parentId === null && editingTag?.parent_id === null && (
                <Box
                  p="3" className="rounded-[var(--radius-3)] border border-[var(--gray-5)] bg-[var(--gray-2)]"
                >
                  <Flex align="center" gap="3">
                    <Controller
                      control={control}
                      name="is_report_root"
                      render={({ field }) => <Checkbox id="edit-tag-report-root" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />}
                    />
                    <Text as="label" htmlFor="edit-tag-report-root" size="2" weight="medium">Use as report namespace</Text>
                  </Flex>
                  <Text size="1" color="gray" as="div" className="mt-1 ml-7">
                    Top-level tag flagged as the root of a reporting hierarchy. Budget items can carry at most one tag per namespace.
                  </Text>

                  {isReportRoot && (
                    <Box className="mt-3 ml-7">
                      <Text id="flow-measure-label" size="2" weight="medium" mb="2" as="div">
                        Flow measure
                      </Text>
                      <Controller
                        control={control}
                        name="report_flow_measure"
                        render={({ field }) => (
                          <RadioGroup.Root
                            aria-labelledby="flow-measure-label"
                            value={field.value}
                            onValueChange={(value) => field.onChange(oneOf(TAG_REPORT_FLOW_MEASURES, value) ?? 'effective')}
                          >
                            <Flex direction="column" gap="2">
                              {FLOW_MEASURE_ORDER.map((v) => ({
                                v,
                                label: v === 'effective' ? `${TAG_REPORT_FLOW_MEASURE_LABELS[v]} (recommended)` : TAG_REPORT_FLOW_MEASURE_LABELS[v],
                                help: FLOW_MEASURE_HELP[v],
                              })).map(opt => (
                                <Text as="label" key={opt.v} size="2">
                                  {/* A label holds phrasing content only: spans, shown as blocks. */}
                                  <Flex as="span" align="start" gap="2">
                                    <RadioGroup.Item
                                      value={opt.v}
                                      className="mt-1"
                                      aria-labelledby={`flow-measure-${opt.v}-label`}
                                      aria-describedby={`flow-measure-${opt.v}-help`}
                                    />
                                    <Box as="span" display="block">
                                      <Text id={`flow-measure-${opt.v}-label`} size="2">{opt.label}</Text>
                                      <Box as="span" display="block">
                                        <Text id={`flow-measure-${opt.v}-help`} size="1" color="gray">{opt.help}</Text>
                                      </Box>
                                    </Box>
                                  </Flex>
                                </Text>
                              ))}
                            </Flex>
                          </RadioGroup.Root>
                        )}
                      />
                    </Box>
                  )}
                </Box>
              )}
            </TagFormFields>

            <Flex gap="3" mt="4" justify="end">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
              <Button type="submit">Save Changes</Button>
            </Flex>
          </form>
        </Dialog.Content>
      </Dialog.Root>

      {/* Move To Dialog (touch-friendly replacement for drag-and-drop) */}
      <Dialog.Root open={movingTag !== null} onOpenChange={(open) => !open && setMovingTag(null)}>
        <Dialog.Content maxWidth="440px">
          <Dialog.Title>Move “{movingTag?.name}”</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Choose a new parent tag, or move it to the root level.
          </Dialog.Description>
          {movingTag && (() => {
            // The parents the server takes: not the tag or one below it, none where the
            // tags below it would pass the deepest level, and none for a report root. The top
            // too, unless four levels of tags or more are below it.
            const candidates = tagMoveTargets(tags, movingTag.id);
            const toTop = mayMoveToTop(tags, movingTag.id);
            return (
              <Flex direction="column" gap="3" mt="4">
                <Flex direction="column" gap="1">
                  <Text as="label" htmlFor="move-tag-parent" size="2" weight="medium">Parent Tag</Text>
                  <Select.Root value={moveTargetId} onValueChange={setMoveTargetId}>
                    <Select.Trigger id="move-tag-parent" variant="surface" />
                    <Select.Content>
                      {toTop && <Select.Item value={NO_PARENT}>None (Root Level)</Select.Item>}
                      {candidates.map(tag => (
                        <Select.Item key={tag.id} value={String(tag.id)}>
                          {tag.hierarchy_path}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Flex>
              </Flex>
            );
          })()}
          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button onClick={confirmMove}>Move Tag</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default TagsPage;
