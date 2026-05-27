import Navbar from '../components/Navbar.jsx'

export default function NoteDetailPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-white">Note Detail Page</h1>
        <p className="mt-3 text-slate-300">This route is ready for your detail page content.</p>
      </main>
    </div>
  )
}
