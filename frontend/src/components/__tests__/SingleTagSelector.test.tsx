import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import SingleTagSelector, { Tag } from '../SingleTagSelector';

// Mock tags data
const mockTags: Tag[] = [
  {
    id: 1,
    uuid: 'tag-1',
    name: 'Groceries',
    color: '#3b82f6',
    icon: 'ShoppingCart',
    parent_id: null,
    level: 0,
    hierarchy_path: 'Groceries',
    is_active: true,
    description: null,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    uuid: 'tag-2',
    name: 'Entertainment',
    color: '#ef4444',
    icon: 'Film',
    parent_id: null,
    level: 0,
    hierarchy_path: 'Entertainment',
    is_active: true,
    description: null,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 3,
    uuid: 'tag-3',
    name: 'Movies',
    color: '#ef4444',
    icon: 'Film',
    parent_id: 2,
    level: 1,
    hierarchy_path: 'Entertainment > Movies',
    is_active: true,
    description: null,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 4,
    uuid: 'tag-4',
    name: 'Inactive Tag',
    color: '#6b7280',
    icon: 'X',
    parent_id: null,
    level: 0,
    hierarchy_path: 'Inactive Tag',
    is_active: false,
    description: null,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

// Wrapper with Radix Theme
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <Theme>{children}</Theme>
);

describe('SingleTagSelector', () => {
  it('renders with placeholder when no tag selected', () => {
    const onChange = vi.fn();
    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
        placeholder="Select a tag..."
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('Select a tag...')).toBeInTheDocument();
  });

  it('displays selected tag', () => {
    const onChange = vi.fn();
    render(
      <SingleTagSelector
        selectedTag={mockTags[0]}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('opens dropdown when clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    const button = screen.getByRole('button');
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();
    });
  });

  it('filters tags based on search term', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    // Open dropdown
    const button = screen.getByRole('button');
    await user.click(button);

    // Type in search
    const searchInput = screen.getByPlaceholderText('Search tags...');
    await user.type(searchInput, 'Entertainment');

    await waitFor(() => {
      expect(screen.getByText('Entertainment')).toBeInTheDocument();
      expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
    });
  });

  it('calls onChange when tag is selected', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    // Open dropdown
    const button = screen.getByRole('button');
    await user.click(button);

    // Wait for dropdown to open and find the option
    const groceriesOption = await screen.findByRole('option', { name: /Groceries/i });

    // Click on the tag
    await user.click(groceriesOption);

    // Verify onChange was called
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(mockTags[0]);
    });
  });

  it('removes selected tag when X button is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SingleTagSelector
        selectedTag={mockTags[0]}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    const removeButton = screen.getByLabelText('Remove Groceries');
    await user.click(removeButton);

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('does not show inactive tags', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
      />,
      { wrapper: Wrapper }
    );

    // Open dropdown
    const button = screen.getByRole('button');
    await user.click(button);

    await waitFor(() => {
      expect(screen.queryByText('Inactive Tag')).not.toBeInTheDocument();
    });
  });

  it('is disabled when disabled prop is true', () => {
    const onChange = vi.fn();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
        disabled={true}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByRole('button', { name: 'Select a tag...' })).toBeDisabled();
  });

  it('displays error message when error prop is provided', () => {
    const onChange = vi.fn();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
        error="This field is required"
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('This field is required')).toBeInTheDocument();
  });

  it('shows label when label prop is provided', () => {
    const onChange = vi.fn();

    render(
      <SingleTagSelector
        selectedTag={null}
        onChange={onChange}
        tags={mockTags}
        label="Select Tag"
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('Select Tag')).toBeInTheDocument();
  });
});
