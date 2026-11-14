import { ConsoleHeader } from '../../components/console-header.tsx';
import { Enrolment } from '../../components/enrolment.tsx';

export default function EnrolPage() {
  return (
    <>
      <ConsoleHeader />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Set up your staff account</h1>
          <Enrolment />
        </div>
      </main>
    </>
  );
}
