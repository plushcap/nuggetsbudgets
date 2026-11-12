import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, LucideIcon } from 'lucide-react';
import { Flex, Heading, Text, IconButton, Box } from '@radix-ui/themes';

interface ReportHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  showBackButton?: boolean;
}

const ReportHeader: React.FC<ReportHeaderProps> = ({
  icon: Icon,
  title,
  description,
  showBackButton = true
}) => {
  const navigate = useNavigate();

  return (
    <Box mb="6">
      <Flex align="center" gap="3" mb="4">
        {showBackButton && (
          <IconButton
            variant="soft"
            color="gray"
            size="3"
            onClick={() => navigate('/reports')}
            className="cursor-pointer"
            aria-label="Back to reports"
          >
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <Icon size={32} className="text-[var(--gray-11)]" aria-hidden="true" />
        <Heading as="h1" size="8" weight="bold" className="text-[var(--gray-12)]">{title}</Heading>
      </Flex>
      <Text size="3" className="text-[var(--gray-11)] ml-14">{description}</Text>
    </Box>
  );
};

export default ReportHeader;
