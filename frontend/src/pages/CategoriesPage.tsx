import React, { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { categoryCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { Routes, Route, Link, useNavigate, useParams } from 'react-router-dom';
import {
  Tag,
  Plus,
  Search,
  Trash2,
  Save
} from 'lucide-react';
import { Box, Card, Flex, Text, Button, TextField, Table, Badge } from '@radix-ui/themes';
import { toast } from 'react-hot-toast';
import { type Category, type CategoryWriteBody } from '../services/api';
import {
  useCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
} from '../hooks/queries';
import { getIconByName } from '../utils/iconCatalog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import ConfirmationDialog from '../components/ConfirmationDialog';
import StretchedLink, { rowClick } from '../components/StretchedLink';
import { useConfirmation } from '../hooks/useConfirmation';
import CategoryFormFields, { type CategoryFormData, createDefaultCategoryForm } from '../components/forms/CategoryFormFields';
import NotFoundPage from './NotFoundPage';
import PageContainer from '../components/PageContainer';

interface CategoryWithUsage extends Category {
  usage_count?: number;
}

const CategoriesPage: React.FC = () => {
  return (
    <Routes>
      <Route index element={<CategoryListPage />} />
      <Route path="add" element={<AddCategoryPage />} />
      <Route path=":uuid/edit" element={<EditCategoryPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
};

// CategoryCard component for mobile view - MUST be defined before CategoryListPage
interface CategoryCardProps {
  category: CategoryWithUsage;
  renderIcon: (iconName: string, size?: number) => React.ReactElement;
  /** The category's edit page: the card's link. */
  editPath: string;
}

const CategoryCard: React.FC<CategoryCardProps> = ({ category, renderIcon, editPath }) => {
  // A category's priority: its own words (categories.priority has no list; 'Undefined' is none).
  const getPriorityColor = (priority?: 'Essential' | 'Optional' | 'Undefined' | (string & {}) | null): 'red' | 'green' | 'gray' => {
    switch (priority) {
      case 'Essential':
        return 'red';
      case 'Optional':
        return 'green';
      default:
        return 'gray';
    }
  };

  return (
    <Card className="transition-all">
      <Flex direction="column" gap="3">
        {/* Header with icon and name */}
        <Flex align="start" gap="3">
          <Flex
            align="center"
            justify="center"
            p="2"
            flexShrink="0" className="bg-[var(--accent-3)] text-[var(--accent-11)] rounded-[var(--radius-3)]"
          >
            {renderIcon(category.icon ?? '', 20)}
          </Flex>
          <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%" minWidth="0">
            <Text size="3" weight="bold" color="gray" highContrast style={{ wordBreak: 'break-word' }} asChild>
              <StretchedLink to={editPath}>{category.name}</StretchedLink>
            </Text>
            {category.priority && category.priority !== 'Undefined' && (
              <Badge color={getPriorityColor(category.priority)} size="1">
                {category.priority}
              </Badge>
            )}
          </Flex>
        </Flex>

        {/* Description */}
        {category.description && (
          <Text size="2" color="gray" style={{ wordBreak: 'break-word' }}>
            {category.description}
          </Text>
        )}

        {/* Notes */}
        {category.notes && (
          <Text size="1" color="gray" style={{ wordBreak: 'break-word' }}>
            {category.notes}
          </Text>
        )}
      </Flex>
    </Card>
  );
};

const CategoryListPage: React.FC = () => {
  const { data: rawCategories = [], isLoading: loading } = useCategoriesQuery();
  // usage_count could be enhanced later with actual usage data
  const categories: CategoryWithUsage[] = useMemo(
    () => rawCategories.map(category => ({ ...category, usage_count: 0 })),
    [rawCategories],
  );
  const [searchTerm, setSearchTerm] = useState('');

  // Column width state - using percentages with localStorage persistence
  const getStoredColumnWidths = () => {
    try {
      const stored = localStorage.getItem('nuggets_category_column_widths');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse stored column widths');
    }
    
    // Default widths if no stored data or parsing fails
    return {
      name: 30,
      description: 40,
      priority: 20,
      icon: 10,
      actions: 0  // Kept for backward compatibility with stored widths
    };
  };

  const [columnWidths, setColumnWidths] = useState(getStoredColumnWidths);
  const [isResizing, setIsResizing] = useState<string | null>(null);
  const startX = 0;
  const startWidths = getStoredColumnWidths();
  
  const navigate = useNavigate();

  const filteredCategories = useMemo(
    () => categories.filter(category =>
      category.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      category.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      category.notes?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      category.priority?.toLowerCase().includes(searchTerm.toLowerCase())
    ),
    [categories, searchTerm],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaX = e.clientX - startX;
      const containerWidth = 1200; // Approximate container width
      const deltaPercent = (deltaX / containerWidth) * 100;

      const newWidths = { ...startWidths };
      
      // Adjust the resizing column with constraints
      switch (isResizing) {
        case 'name':
          newWidths.name = Math.max(15, Math.min(40, startWidths.name + deltaPercent));
          break;
        case 'description':
          newWidths.description = Math.max(20, Math.min(50, startWidths.description + deltaPercent));
          break;
        case 'priority':
          newWidths.priority = Math.max(10, Math.min(30, startWidths.priority + deltaPercent));
          break;
        case 'icon':
          newWidths.icon = Math.max(8, Math.min(15, startWidths.icon + deltaPercent));
          break;
      }

      setColumnWidths(newWidths);
    };

    const handleMouseUp = () => {
      // Save to localStorage when resizing is complete
      if (isResizing && columnWidths) {
        try {
          localStorage.setItem('nuggets_category_column_widths', JSON.stringify(columnWidths));
        } catch (error) {
          logger.warn({ err: error }, 'Failed to save column widths to localStorage');
        }
      }
      setIsResizing(null);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing, startX, startWidths, columnWidths]);

  const renderIcon = (iconName: string, size = 20) => {
    const iconOption = getIconByName(iconName);
    if (iconOption) {
      const IconComponent = iconOption.component;
      return <IconComponent size={size} />;
    }
    return <Box width={`${size}px`} height={`${size}px`} className="bg-[var(--gray-5)] rounded-[var(--radius-2)]" />;
  };

  if (loading) {
    return (
      <PageContainer>
        <Flex direction="column" gap="4">
          <Box
            height="32px" width="25%" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]"
          />
          <Flex direction="column" gap="4">
            {[1, 2, 3].map(i => (
              <Box
                key={i}
                height="80px" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]"
              />
            ))}
          </Flex>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Categories"
        subtitle="Organize your budget with custom categories"
        icon={<Tag size={20} className="text-[var(--green-12)]" />}
        iconBackground="bg-[var(--green-3)]"
        backPath="/settings"
        primaryAction={{
          label: 'Add Category',
          onClick: () => navigate('/categories/add'),
          icon: <Plus size={16} />
        }}
      />

      {/* Search and Stats */}
      <Card mb="5">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box position="relative" flexGrow="1" flexBasis="0%" maxWidth="448px">
            <TextField.Root
              size="3"
              aria-label="Search categories"
              placeholder="Search categories..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            >
              <TextField.Slot>
                <Search size={16} className="text-[var(--gray-11)]" />
              </TextField.Slot>
            </TextField.Root>
          </Box>
          <Flex align="center" gap="4">
            <Text size="2" color="gray">
              Total Categories: {filteredCategories.length}
            </Text>
            <Text size="2" className="text-[var(--green-12)]">
              Active: {categories.length}
            </Text>
          </Flex>
        </Flex>
      </Card>

      {/* Mobile Card View */}
      <Box display={{ initial: 'block', md: 'none' }}>
        <Flex direction="column" gap="4">
          {filteredCategories.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              renderIcon={renderIcon}
              editPath={`/categories/${category.uuid}/edit`}
            />
          ))}
        </Flex>
      </Box>

      {/* Desktop Table View */}
      <Box display={{ initial: 'none', md: 'block' }}>
        <Table.Root variant="surface">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Category Name</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Description</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Priority</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Icon</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>

          <Table.Body>
            {filteredCategories.map((category) => (
              <Table.Row 
                key={category.id}
                onClick={rowClick(() => navigate(`/categories/${category.uuid}/edit`))}
                className="cursor-pointer"
              >
                <Table.Cell>
                  <Text weight="bold" color="gray" highContrast asChild>
                    <Link to={`/categories/${category.uuid}/edit`} className="hover:underline">{category.name}</Link>
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  {category.description ? (
                    <Text color="gray">{category.description}</Text>
                  ) : (
                    <Text color="gray">—</Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {category.priority && category.priority !== 'Undefined' ? (
                    <Badge highContrast color={category.priority === 'Essential' ? 'red' : category.priority === 'Optional' ? 'green' : 'gray'} size="1">
                      {category.priority}
                    </Badge>
                  ) : (
                    <Text color="gray">—</Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Box
                    p="2" display="inline-block" className="rounded-[var(--radius-4)] bg-[var(--accent-3)] text-[var(--accent-11)]"
                  >
                    {renderIcon(category.icon ?? '', 20)}
                  </Box>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>

      {/* Empty State */}
      {filteredCategories.length === 0 && !loading && (
        <Card mt={{ initial: '5', sm: '0' }}>
          <Flex direction="column" align="center" gap="4" py="9">
            <Tag size={48} className="md:w-16 md:h-16 text-[var(--gray-6)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="bold" color="gray" highContrast>
                {searchTerm ? 'No categories found' : 'No categories yet'}
              </Text>
              <Text size="2" color="gray">
                {searchTerm 
                  ? 'Try adjusting your search terms' 
                  : 'Add your first category to get started'
                }
              </Text>
            </Flex>
            {!searchTerm && (
              <Button
                onClick={() => navigate('/categories/add')}
                size="3"
              >
                <Plus size={16} />
                Add Category
              </Button>
            )}
          </Flex>
        </Card>
      )}
    </PageContainer>
  );
};

// The body a create or an update sends. A PUT replaces the category, so every field is
// sent: an empty description or notes, and the 'Undefined' priority, as none (null).
const categoryBody = (formData: CategoryFormData): CategoryWriteBody => ({
  name: formData.name.trim(),
  description: formData.description?.trim() || null,
  priority: formData.priority && formData.priority !== 'Undefined' ? formData.priority : null,
  notes: formData.notes?.trim() || null,
  icon: formData.icon,
});

// Add Category Page
const AddCategoryPage: React.FC = () => {
  const createCategoryMutation = useCreateCategoryMutation();
  const saving = createCategoryMutation.isPending;
  const navigate = useNavigate();

  const form = useForm<CategoryFormData>({
    defaultValues: createDefaultCategoryForm(),
    resolver: zodResolver(categoryCreateSchema) as never,
  });
  const { handleSubmit, getValues } = form;

  const onSubmit = async () => {
    const formData = getValues();
    try {
      await createCategoryMutation.mutateAsync(categoryBody(formData));

      toast.success('Category created successfully');
      navigate('/categories');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create category');
      toast.error(errorMessage(error, 'Failed to create category'));
    }
  };

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Add Category"
        subtitle="Create a new budget category"
        icon={<Tag size={20} className="text-[var(--green-12)]" />}
        iconBackground="bg-[var(--green-3)]"
        backPath="/categories"
        primaryAction={{
          label: 'Create Category',
          onClick: (e) => {
            e?.preventDefault();
            void handleSubmit(onSubmit)();
          },
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving
        }}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CategoryFormFields form={form} />
        </form>
      </Card>
    </PageContainer>
  );
};

const EditCategoryPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const deleteConfirmation = useConfirmation();
  const navigate = useNavigate();

  const { data: categories = [], isLoading } = useCategoriesQuery();
  const category = useMemo(() => categories.find(c => c.uuid === uuid) ?? null, [categories, uuid]);
  const loading = isLoading;
  const updateCategoryMutation = useUpdateCategoryMutation();
  const deleteCategoryMutation = useDeleteCategoryMutation();
  const saving = updateCategoryMutation.isPending;

  const form = useForm<CategoryFormData>({
    defaultValues: createDefaultCategoryForm(),
    resolver: zodResolver(categoryCreateSchema) as never,
  });
  const { handleSubmit, reset, getValues } = form;

  // Seed the form when the category loads; redirect if it can't be found.
  useEffect(() => {
    if (category) {
      reset({
        name: category.name,
        description: category.description || '',
        priority: category.priority || 'Undefined',
        notes: category.notes || '',
        icon: category.icon ?? ''
      });
    } else if (!isLoading && uuid) {
      toast.error('Failed to load category');
      navigate('/categories');
    }
  }, [category, isLoading, uuid, navigate, reset]);

  const onSubmit = async () => {
    if (!category) return;
    const formData = getValues();
    try {
      await updateCategoryMutation.mutateAsync({ uuid: category.uuid, data: categoryBody(formData) });

      toast.success('Category updated successfully');
      navigate('/categories');
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update category');
      toast.error(errorMessage(error, 'Failed to update category'));
    }
  };

  const handleDelete = async () => {
    if (!category) return;

    deleteConfirmation.setIsLoading(true);
    try {
      await deleteCategoryMutation.mutateAsync(category.uuid);
      toast.success('Category deleted successfully');
      navigate('/categories');
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete category');
      if (errorMessage(error, '').includes('Category in use')) {
        toast.error('This category is in use and cannot be deleted.');
      } else {
        toast.error('Failed to delete category');
      }
    } finally {
      deleteConfirmation.setIsLoading(false);
    }
  };

  if (loading) {
    return (
      <PageContainer width="form">
        <Flex direction="column" gap="4">
          <Box
            height="48px" width="calc(100% / 3)" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]"
          />
          <Box
            height="384px" className="rounded-[var(--radius-5)] animate-pulse bg-[var(--gray-3)]"
          />
        </Flex>
      </PageContainer>
    );
  }

  if (!category) {
    return (
      <PageContainer width="form">
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Text size="5" weight="bold" color="gray" highContrast>
              Category not found
            </Text>
            <Link to="/categories">
              <Text size="2" className="text-[var(--accent-11)]">
                Return to categories
              </Text>
            </Link>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Edit Category"
        subtitle="Update category information"
        icon={<Tag size={20} className="text-[var(--green-12)]" />}
        iconBackground="bg-[var(--green-3)]"
        backPath="/categories"
        primaryAction={{
          label: 'Save Changes',
          onClick: (e) => {
            e?.preventDefault();
            void handleSubmit(onSubmit)();
          },
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving
        }}
        secondaryAction={{
          label: 'Delete',
          onClick: () => deleteConfirmation.confirm(handleDelete, {
            title: 'Delete Category',
            message: `Are you sure you want to delete "${category.name}"? This action cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger',
          }),
          icon: <Trash2 size={16} />,
          variant: 'secondary'
        }}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CategoryFormFields form={form} />
        </form>
      </Card>

      {/* Delete Confirmation Dialog */}
      <ConfirmationDialog {...deleteConfirmation.dialogProps} />
    </PageContainer>
  );
};

export default CategoriesPage;