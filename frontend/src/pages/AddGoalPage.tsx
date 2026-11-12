import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UNREADABLE_REQUIRED_AMOUNT_MESSAGE, withUnreadableAmounts } from '../components/forms/optionalAmount';
import { goalCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { compareCalendarDates, todayLocal } from '../utils/dateUtils';
import { useNavigate } from 'react-router-dom';
import { Target } from 'lucide-react';
import { useCreateGoalMutation, useUploadGoalImageMutation } from '../hooks/queries/goals';
import toast from 'react-hot-toast';
import BudgetItemNamespaceTags from '../components/BudgetItemNamespaceTags';
import PageHeader from '../components/PageHeader';
import { Card, Flex, Box, Button } from '@radix-ui/themes';
import GoalFormFields, { type GoalFormData, createDefaultGoalForm } from '../components/forms/GoalFormFields';
import PageContainer from '../components/PageContainer';

const AddGoalPage: React.FC = () => {
  const navigate = useNavigate();
  const createGoalMutation = useCreateGoalMutation();
  const uploadGoalImageMutation = useUploadGoalImageMutation();
  const loading = createGoalMutation.isPending || uploadGoalImageMutation.isPending;

  // Image (File) kept outside RHF; uploaded separately after the goal is created.
  const [goalImage, setGoalImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const form = useForm<GoalFormData>({
    defaultValues: createDefaultGoalForm(),
    resolver: withUnreadableAmounts(zodResolver(goalCreateSchema), { target_amount: UNREADABLE_REQUIRED_AMOUNT_MESSAGE }) as never,
  });
  const { handleSubmit, getValues } = form;

  // GoalFormFields has checked it (imageUploadProblem), and says beside the button why not.
  const handleImageChange = (file: File) => {
    setGoalImage(file);
    const reader = new FileReader();
    reader.onloadend = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setGoalImage(null);
    setImagePreview(null);
  };

  const onSubmit = async () => {
    // name / target_amount (> 0) / target_date are validated by goalCreateSchema.
    // The future-date check stays here (it's not part of the API schema).
    const formData = { ...getValues(), goal_image: goalImage };

    // Calendar days, compared as such: today itself is allowed.
    if (compareCalendarDates(formData.target_date, todayLocal()) < 0) {
      toast.error('Target date must be in the future');
      return;
    }

    try {
      const response = await createGoalMutation.mutateAsync(formData);
      const newGoal = response.goal;

      if (formData.goal_image instanceof File) {
        try {
          await uploadGoalImageMutation.mutateAsync({ uuid: newGoal.uuid, formData: formData.goal_image });
        } catch (error) {
          logger.error({ err: error }, 'Failed to upload goal image');
          toast.error('Goal created but image upload failed');
        }
      }

      toast.success('Goal created successfully!');
      navigate('/goals');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create goal');
      toast.error('Failed to create goal');
    }
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <PageHeader
        title="Create New Goal"
        subtitle="Set up a new financial goal to track"
        icon={<Target size={20} />}
        backPath="/goals"
      />

      {/* Form */}
      <Card>
        <Flex asChild direction="column" gap="6">
        <form onSubmit={handleSubmit(onSubmit)}>
          <GoalFormFields
            form={form}
            imagePreview={imagePreview}
            onImageChange={handleImageChange}
            onRemoveImage={removeImage}
          />

          {/* Action Buttons */}
          <Flex
            gap="3"
            pt="4"
            className="border-t border-[var(--gray-6)]"
          >
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={() => navigate('/goals')}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              loading={loading}
              className="flex-1"
            >
              Create Goal
            </Button>
          </Flex>
        </form>
        </Flex>
      </Card>

      {/* Report namespace tags — won't render selectors until the goal is saved */}
      <Box mt="6">
        <BudgetItemNamespaceTags budgetItemUuid={null} />
      </Box>
    </PageContainer>
  );
};

export default AddGoalPage;
