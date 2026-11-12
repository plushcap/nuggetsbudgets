import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { user } from '../../../test/fixtures';
import { Assignee } from '../TransactionCells';
import { personInitials, personName } from '../../../utils/personName';

/**
 * A person's first or last name may be null (users.first_name and last_name are nullable, and
 * the API answers them as they are). An assignee without a last name showed
 * `null.charAt` as a crash of the whole transaction table.
 */
describe('a person with no first or last name', () => {
  it('names them by what is set, and falls back when nothing is', () => {
    expect(personName({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('Ada Lovelace');
    expect(personName({ first_name: 'Ada', last_name: null })).toBe('Ada');
    expect(personName({ first_name: null, last_name: ' Lovelace ' })).toBe('Lovelace');
    expect(personName({ first_name: null, last_name: null }, 'ada@example.com')).toBe('ada@example.com');
    expect(personInitials({ first_name: 'Ada', last_name: null })).toBe('A');
    expect(personInitials({ first_name: '', last_name: null })).toBe('?');
  });

  it('shows an assignee without a last name, by their initial and first name', () => {
    const ada = user({ id: 3, first_name: 'Ada', last_name: null });
    render(
      <Theme>
        <Assignee user={ada} />
      </Theme>
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Assigned to Ada')).toBeInTheDocument();
    expect(screen.getByTitle('Ada')).toBeInTheDocument();
  });

  it('shows an assignee with no name at all', () => {
    render(
      <Theme>
        <Assignee user={user({ id: 4, first_name: null, last_name: null })} />
      </Theme>
    );
    expect(screen.getByText('?')).toBeInTheDocument();
    expect(screen.getByText('Assigned to Unnamed')).toBeInTheDocument();
  });
});
