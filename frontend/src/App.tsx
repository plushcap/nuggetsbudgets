import { Suspense } from 'react';
import { Flex } from '@radix-ui/themes';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import FlexLayout from './components/FlexLayout';
import NuggetSpinner from './components/NuggetSpinner';
import ErrorBoundary from './components/ErrorBoundary';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';

// Page routes are lazy-loaded so each page ships as its own chunk. This
// keeps the initial bundle small — heavy pages (e.g. @nivo-powered charts) are
// only fetched when the user actually navigates to them. Mirrors the existing
// lazy/Suspense convention in pages/ReportsPage.tsx.
const LoginPage = lazy(() => import('./pages/LoginPage'));
const AdminSetupPage = lazy(() => import('./pages/AdminSetupPage'));
const UnsubscribePage = lazy(() => import('./pages/UnsubscribePage'));
const AcceptInvitationPage = lazy(() => import('./pages/AcceptInvitationPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AccountsPage = lazy(() => import('./pages/AccountsPage'));
const AddAccountPage = lazy(() => import('./pages/AddAccountPage'));
const EditAccountPage = lazy(() => import('./pages/EditAccountPage'));
const AccountDetailPage = lazy(() => import('./pages/AccountDetailPage'));
const InvestmentsPage = lazy(() => import('./pages/InvestmentsPage'));
const SecuritiesPage = lazy(() => import('./pages/SecuritiesPage'));
const AddSecurityPage = lazy(() => import('./pages/AddSecurityPage'));
const RecordBuyPage = lazy(() => import('./pages/RecordBuyPage'));
const RecordSellPage = lazy(() => import('./pages/RecordSellPage'));
const RecordDividendPage = lazy(() => import('./pages/RecordDividendPage'));
const PositionDetailPage = lazy(() => import('./pages/PositionDetailPage'));
const InvestmentAllocationPage = lazy(() => import('./pages/InvestmentAllocationPage'));
const InvestmentExposurePage = lazy(() => import('./pages/InvestmentExposurePage'));
const InvestmentValueSeriesPage = lazy(() => import('./pages/InvestmentValueSeriesPage'));
const InvestmentCostsPage = lazy(() => import('./pages/InvestmentCostsPage'));
const InvestmentTaxPage = lazy(() => import('./pages/InvestmentTaxPage'));
const InvestmentActivityPage = lazy(() => import('./pages/InvestmentActivityPage'));
const RecordFeePage = lazy(() => import('./pages/RecordFeePage'));
const CorporateActionPage = lazy(() => import('./pages/CorporateActionPage'));
const AddPricePage = lazy(() => import('./pages/AddPricePage'));
const EditSecurityPage = lazy(() => import('./pages/EditSecurityPage'));
const CostBasisSettingsPage = lazy(() => import('./pages/CostBasisSettingsPage'));
const DataFreshnessPage = lazy(() => import('./pages/DataFreshnessPage'));
const InvestmentPlanningPage = lazy(() => import('./pages/InvestmentPlanningPage'));
const InvestmentPerformancePage = lazy(() => import('./pages/InvestmentPerformancePage'));
const InvestmentReconciliationPage = lazy(() => import('./pages/InvestmentReconciliationPage'));
const AddTransactionPage = lazy(() => import('./pages/AddTransactionPage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const TransactionDetailPage = lazy(() => import('./pages/TransactionDetailPage'));
const TransferMoneyPage = lazy(() => import('./pages/TransferMoneyPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const AnnotationsInboxPage = lazy(() => import('./pages/AnnotationsInboxPage'));
const CategoriesPage = lazy(() => import('./pages/CategoriesPage'));
const TagsPage = lazy(() => import('./pages/TagsPage'));
const ViewTagPage = lazy(() => import('./pages/ViewTagPage'));
const BudgetPage = lazy(() => import('./pages/BudgetPage'));
const BillsPage = lazy(() => import('./pages/BillsPage'));
const ViewBudgetItemPage = lazy(() => import('./pages/ViewBudgetItemPage'));
const EditBudgetItemPage = lazy(() => import('./pages/EditBudgetItemPage'));
const AddBudgetItemPage = lazy(() => import('./pages/AddBudgetItemPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const BankImportSyncHistoryPage = lazy(() => import('./pages/BankImportSyncHistoryPage'));
const SimpleFinAccountsPage = lazy(() => import('./pages/SimpleFinAccountsPage'));
const BudgetItemRulesPage = lazy(() => import('./pages/BudgetItemRulesPage'));
const GoalsPage = lazy(() => import('./pages/GoalsPage'));
const AddGoalPage = lazy(() => import('./pages/AddGoalPage'));
const EditGoalPage = lazy(() => import('./pages/EditGoalPage'));
const GoalAnalysisPage = lazy(() => import('./pages/GoalAnalysisPage'));
const CloseOutPage = lazy(() => import('./pages/CloseOutPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function App() {
  // AuthProvider and Toaster are mounted once at the root in index.tsx.
  // Don't re-mount them here — doing so registers the session-expired
  // listener twice (which is what was causing duplicate "session expired"
  // toasts) and creates two AuthContext instances that disagree about the
  // current user.
  const location = useLocation();
  return (
    <>
      {/* Error boundary: turns a lazy-chunk load failure or a render-time
          exception into a recoverable fallback instead of a blank screen.
          Resets on navigation so a transient error clears. */}
      <ErrorBoundary resetKeys={[location.pathname]}>
      {/* Outer Suspense: catches the lazy public routes and the very first load. */}
      <Suspense fallback={
        <Flex justify="center" align="center" height="100vh">
          <NuggetSpinner size={40} />
        </Flex>
      }>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin-setup" element={<AdminSetupPage />} />
        <Route path="/unsubscribe" element={<UnsubscribePage />} />

        {/* Protected routes */}
        <Route path="/*" element={
          <ProtectedRoute>
            <FlexLayout>
              {/* Inner boundary: keeps the FlexLayout chrome mounted while only
                  the content region recovers from an error or shows a spinner
                  during protected page transitions. */}
              <ErrorBoundary resetKeys={[location.pathname]}>
              <Suspense fallback={
                <Flex justify="center" align="center" height="256px">
                  <NuggetSpinner size={32} />
                </Flex>
              }>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/invitations/accept" element={<AcceptInvitationPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/accounts/add" element={<AddAccountPage />} />
                {/* Edit route with explicit path to avoid conflicts */}
                <Route path="/accounts/edit/:uuid" element={<EditAccountPage />} />
                <Route path="/accounts/:accountUuid/add-transaction" element={<AddTransactionPage />} />
                <Route path="/accounts/:uuid" element={<AccountDetailPage />} />
                <Route path="/investments" element={<InvestmentsPage />} />
                <Route path="/investments/securities" element={<SecuritiesPage />} />
                <Route path="/investments/securities/add" element={<AddSecurityPage />} />
                <Route path="/investments/securities/:uuid/edit" element={<EditSecurityPage />} />
                <Route path="/investments/prices/add" element={<AddPricePage />} />
                <Route path="/investments/fee" element={<RecordFeePage />} />
                <Route path="/investments/corporate-action" element={<CorporateActionPage />} />
                <Route path="/investments/settings" element={<CostBasisSettingsPage />} />
                <Route path="/investments/freshness" element={<DataFreshnessPage />} />
                <Route path="/investments/planning" element={<InvestmentPlanningPage />} />
                <Route path="/investments/performance" element={<InvestmentPerformancePage />} />
                <Route path="/investments/reconciliation" element={<InvestmentReconciliationPage />} />
                <Route path="/investments/buy" element={<RecordBuyPage />} />
                <Route path="/investments/sell" element={<RecordSellPage />} />
                <Route path="/investments/dividend" element={<RecordDividendPage />} />
                <Route path="/investments/positions/:securityUuid" element={<PositionDetailPage />} />
                <Route path="/investments/allocation" element={<InvestmentAllocationPage />} />
                <Route path="/investments/exposure" element={<InvestmentExposurePage />} />
                <Route path="/investments/value-series" element={<InvestmentValueSeriesPage />} />
                <Route path="/investments/costs" element={<InvestmentCostsPage />} />
                <Route path="/investments/tax" element={<InvestmentTaxPage />} />
                <Route path="/investments/activity" element={<InvestmentActivityPage />} />
                <Route path="/transactions" element={<TransactionsPage />} />
                <Route path="/transactions/:uuid" element={<TransactionDetailPage />} />
                <Route path="/transfertransaction" element={<TransferMoneyPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/activity" element={<AnnotationsInboxPage />} />
                <Route path="/budgets" element={<BudgetPage />} />
                <Route path="/bills" element={<BillsPage />} />
                <Route path="/budget-items/add" element={<AddBudgetItemPage />} />
                <Route path="/budget-items/:budgetItemUuid/view" element={<ViewBudgetItemPage />} />
                <Route path="/budget-items/:uuid/edit" element={<EditBudgetItemPage />} />
                <Route path="/close-out" element={<CloseOutPage />} />
                <Route path="/budget-items/:budgetItemUuid/rules" element={<BudgetItemRulesPage />} />
                <Route path="/goals" element={<GoalsPage />} />
                <Route path="/goals/add" element={<AddGoalPage />} />
                <Route path="/goals/:uuid/view" element={<GoalAnalysisPage />} />
                <Route path="/goals/:uuid/edit" element={<EditGoalPage />} />
                <Route path="/categories/*" element={<CategoriesPage />} />
                <Route path="/tags" element={<TagsPage />} />
                <Route path="/tags/:tagUuid" element={<ViewTagPage />} />
                <Route path="/import/sync-history" element={<BankImportSyncHistoryPage />} />
                <Route path="/import/simplefin-accounts" element={<SimpleFinAccountsPage />} />
                {/* The Bank Import page's address is /settings/import-settings, behind its
                    settings gate; this one used to show it without. */}
                <Route path="/import/settings" element={<Navigate to="/settings/import-settings" replace />} />
                <Route path="/reports/*" element={<ReportsPage />} />
                <Route path="/settings/*" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
              </Suspense>
              </ErrorBoundary>
            </FlexLayout>
          </ProtectedRoute>
        } />
      </Routes>
      </Suspense>
      </ErrorBoundary>
    </>
  );
}

export default App;
