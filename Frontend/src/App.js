import { createElement } from 'react'
import { Route, Routes } from 'react-router'
import HomePage from './pages/HomePage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import HowToPlayPage from './pages/HowToPlayPage.jsx'
import LeaderboardsPage from './pages/LeaderboardsPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'
import ProfileStatsPage from './pages/ProfileStatsPage.jsx'
import CreatePage from './pages/CreatePage.jsx'
import NoteDetailPage from './pages/NoteDetailPage.jsx'
import OAuthCallbackPage from './pages/OAuthCallbackPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import ResetPasswordPage from './pages/ResetPasswordPage.jsx'
import InboxPage from './pages/InboxPage.jsx'
import InviteRedirectPage from './pages/InviteRedirectPage.jsx'
import GamePage from './pages/GamePage.jsx'
import AdminReportsPage from './pages/AdminReportsPage.jsx'

const App = () => {
	return createElement(
		'div',
		{ className: 'relative h-full w-full' },
		createElement(
			Routes,
			null,
			createElement(Route, { path: '/', element: createElement(HomePage) }),
			createElement(Route, { path: '/home', element: createElement(DashboardPage) }),
			createElement(Route, { path: '/how-to-play', element: createElement(HowToPlayPage) }),
			createElement(Route, { path: '/leaderboards', element: createElement(LeaderboardsPage) }),
			createElement(Route, { path: '/profile', element: createElement(ProfilePage) }),
			createElement(Route, { path: '/profile/stats', element: createElement(ProfileStatsPage) }),
			createElement(Route, { path: '/oauth/callback', element: createElement(OAuthCallbackPage) }),
			createElement(Route, { path: '/join/:inviteToken', element: createElement(InviteRedirectPage) }),
			createElement(Route, { path: '/invite/:inviteToken', element: createElement(InviteRedirectPage) }),
			createElement(Route, { path: '/forgot-password', element: createElement(ForgotPasswordPage) }),
			createElement(Route, { path: '/reset-password', element: createElement(ResetPasswordPage) }),
			createElement(Route, { path: '/create', element: createElement(CreatePage) }),
			createElement(Route, { path: '/game/:gameId', element: createElement(GamePage) }),
			createElement(Route, { path: '/inbox', element: createElement(InboxPage) }),
			createElement(Route, { path: '/note/:id', element: createElement(NoteDetailPage) }),
			createElement(Route, { path: '/admin/reports', element: createElement(AdminReportsPage) }),
		),
	)
}

export default App
