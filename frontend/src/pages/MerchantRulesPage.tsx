import React, { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Box, Button, Card, Flex, Text } from '@radix-ui/themes';
import { Settings } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useMerchantQuery, useMerchantRulesQuery } from '../hooks/queries';
import { useMerchantRuleEditor } from '../hooks/useMerchantRuleEditor';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageContainer from '../components/PageContainer';
import MerchantRuleForm from '../components/merchants/MerchantRuleForm';
import MerchantRuleList from '../components/merchants/MerchantRuleList';
import MerchantRuleTestSection from '../components/merchants/MerchantRuleTestSection';
import { merchantPaths } from '../components/merchants/merchantFields';
import { EMPTY_LIST } from '../utils/emptyList';

/** A merchant's matching rules: add, edit and delete them, and test what they match. */
const MerchantRulesPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const { data: merchant = null, isError } = useMerchantQuery(uuid);
  const { data: rules = EMPTY_LIST, isLoading: loading } = useMerchantRulesQuery(uuid);
  const editor = useMerchantRuleEditor(merchant);

  // Back to the list if the merchant can't be loaded.
  useEffect(() => {
    if (isError) {
      toast.error('Failed to load merchant rules');
      navigate(merchantPaths.list);
    }
  }, [isError, navigate]);

  if (loading) {
    return (
      <PageContainer>
        <Flex direction="column" gap="4">
          <Box height="32px" width="25%" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]" />
          <Flex direction="column" gap="4">
            {[1, 2, 3].map((i) => (
              <Box key={i} height="64px" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]" />
            ))}
          </Flex>
        </Flex>
      </PageContainer>
    );
  }

  if (!merchant) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Text size="6" weight="bold" color="gray" highContrast>
              Merchant not found
            </Text>
            <Button color="blue" size="3" asChild>
              <Link to={merchantPaths.list}>Return to merchants</Link>
            </Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Matching Rules"
        subtitle={`Manage rules for ${merchant.name}`}
        icon={<Settings size={20} className="text-[var(--orange-12)]" />}
        iconBackground="bg-[var(--orange-3)]"
        backPath={merchantPaths.list}
        primaryAction={{
          label: 'Add Rule',
          onClick: editor.openNew,
        }}
      />

      {editor.formOpen && (
        <MerchantRuleForm
          form={editor.form}
          editing={editor.editingRule !== null}
          onSave={editor.save}
          onClose={editor.closeForm}
          saving={editor.saving}
        />
      )}

      <MerchantRuleList rules={rules} onAdd={editor.openNew} onEdit={editor.startEdit} onDelete={editor.deleteRule} />

      {rules.length > 0 && <MerchantRuleTestSection merchant={merchant} />}

      <ConfirmationDialog {...editor.confirmationProps} />
    </PageContainer>
  );
};

export default MerchantRulesPage;
