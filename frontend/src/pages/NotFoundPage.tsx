import React from 'react';
import { Link } from 'react-router-dom';
import { Button, Flex, Heading, Text } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

/** Shown for an address no route matches, instead of an empty page. */
const NotFoundPage: React.FC = () => (
  <PageContainer width="form" py="9">
    <Flex direction="column" align="center" gap="4">
      <Heading size="6">Page not found</Heading>
      <Text color="gray" align="center">
        Nothing lives at this address. The link may be out of date.
      </Text>
      <Button asChild>
        <Link to="/">Go to the dashboard</Link>
      </Button>
    </Flex>
  </PageContainer>
);

export default NotFoundPage;
